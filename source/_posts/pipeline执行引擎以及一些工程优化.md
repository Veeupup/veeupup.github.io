---
title: pipeline执行引擎以及一些工程优化
date: 2023-04-30 15:13:04
tags:
- 数据仓库
- 执行引擎
---

# 基础概念

## 简单介绍

pipeline 是一种**执行引擎模型**，是通过将复杂的计算链路拆分成多个小部分，通过各种手段来执行 pipeline 中的任务完成高效率的计算。

> 在 Morsel, Clickhouse, Databend, Datafusion, DuckDB 中对于 pipeline 都有不同程度的实现

pipeline 本质上就是将计算任务抽象成一个 DAG，然后将每个节点抽象为一个 TASK，pipeline 将完成任务之间的调度执行顺序和数据传输。

下图描述了 clickhouse 中的 pipeline 如何 pipeline 的抽象的：

> [来源 Clickhouse Presentation meetup24](https://presentations.clickhouse.com/meetup24/5.%20Clickhouse%20query%20execution%20pipeline%20changes/#parallel-execution)

![image-20230310224134113](image-20230310224134113.png)

图中表示了一个计算任务之间的有向无环图，也就是一个 pipeline 

整个计算链路串起来叫做 pipeline，图中的每个方框内的算子叫做 processor，可以来处理一个计算任务，Ports 代表 processor 之间的数据连接。

注意每个 processor 都可以有一个或者多个 input ，可以有一个或者多个输出，也就是 pipeline 的变换是非常灵活的，可以 1 -> 1, N -> 1, 1 -> N。

这里介绍图中没有的另一个概念：pipeline breaker，所谓 pipeline breaker 就是在多个 pipeline 的执行的时候不能顺畅的执行下去，需要等这个同步的点执行完毕才能继续执行。

例如一个 hash join 的 build hashtable 阶段，就是一个 pipeline breaker，下面的 pipe2 需要等待 pipe1 的 build hashtable 结束之后才能开始 probe 阶段，就阻碍的 pipe2 的继续执行

```
pipe1: source1 -> project -> build hashtable ->
  												->
  													->			---> transform1
pipe2: source2 -> project  ----------------------------> probe  ---> transform2
																---> transform3
```

## 如何更快的进行执行计算任务

这是一个很大的问题，这里总结一下在计算任务中提高执行计算效率的一些方法：

要注意要提高计算性能，借用 Andy 课中的总结，核心就是三个点：

1. 减少指令数量
   1. 向量化，每条指令处理更多数据
   2. ……
2. 减少每条指令的平均 cycle
   1. branchless, make cpu pipeline prediction happy
   2. ……
3. 并行执行
   1. 将执行**水平切分**，**竖直切分**

本文不详细展开了，每个点展开又是一个很大的话题。就是要**让CPU一直转起来，而且要转在更有效率的地方**，而不是画这个时间在调度，function call，memory access上面。

而一个好的调度程序就是能够通过上面的三种方式来提高执行效率

* 1: 通过调度尽可能减少 function call 的指令以及额外的调度
* 2: 通过 Numa-aware 的方式减少 memory access 的 cycle
* 3: 通过并行手段将完整的计算任务水平与竖直进行切分提高效率

## 和 volcano 执行模型的对比

不同于传统的 valcano 的执行引擎，最大的不同就是 pipeline 具有**显式的计算控制流程**（也就是实现了手动调度任务），而 volcano 执行引擎是通过函数调用来实现隐式的计算控制流。

> **[alexey-milovidov](https://github.com/alexey-milovidov)** ：The main difference is that volcano has implicit control flow (calculations are controlled by function call stack) and pipeline has explicit control flow (there is query execution graph and external scheduler can select what computation blocks to run in what threads).
>
> https://github.com/ClickHouse/ClickHouse/issues/34045

# 一些工程优化

由于 pipeline 的本质概念上比较简单，工程上有很多可以优化的点

## batch-execution

 一个前提：注意这里的 pipeline 执行一般都是以 batch 为单位执行的，和 row-oriented 的执行引擎对比来说

execution row by row:

* simple
* High overhead

Batch execution:

* small overhead (control overhead)
  * 以 MonetDB 论文中的数据说明，MySQL 真正用于计算的只小于 10% 的时间，更多的时间花在了各种不同的
  * ![image-20230310215338663](MonetDBx100.png)
* vectorized execution
* greater memory consumption

### explict schedule

总的来说，pipeline 将一个大的计算流程表示为一个 **DAG 有向无环图**，图中的每个节点转化为作为 pipeline 计算中的一个个的 task 或者叫 processor, 每个 processor 只负责其中的一个子任务，然后将这些 processor 逻辑上连接起来，所以**如何调度这个 DAG 的执行是影响执行效率很大的一个因素**。

* 最朴素的实现里面可以直接将每个 task 抽象出来放到一个线程池里面去跑 或者是 thread per prossor，**不做任何显式或者隐式的调度**，任务之间既不 pull 也不 push，轮到谁跑谁就尝试去跑，如果发现不能继续就 yield，然后尝试，每个线程不断轮询 DAG 中的任务，哪个能够执行就去执行，直到最终 task queue 中没有任务即可停止。
  * 优点：实现简单
  * 缺点：OS or 线程池不知道任务之间的依赖关系，可能产生非常多的调度开销，而且不利于做后续的 numa-aware 优化

> 在 Rust 中也有不少用异步的实现直接把任务丢到 tokio 中去跑，让 tokio 来做调度

* 另一种方法可以采用 pull-based schedule，同样也放到 线程池中去跑，只不过这个时候的调度顺序从下游节点向上游节点发起，也是隐式的调度（通过 function call）
  * 优点：
    * 实现简单
    * 容易可以做一些算子的下推：例如 limit 算子
  * 缺点：
    * 仍然有不少的调度开销
* 效率比较高的一种调度就是 push-based schedule，由 bottom-to-top 的执行，上游节点执行完毕就通知相邻的下游 processor 执行，把下游节点放到 task queue 中去，这个时候用于调度的时间会更少，真正执行的时间占比会更高
  * 优点：
    * 减少非常多无用的调度开销
    * 以数据为中心计算，刚才算子计算的数据仍然在 cpu cahce 中，效率更高
      * 所以很多最开始水平切分最小的 batch 的时候尽可能和 CPU cache 大小相等，这样 cache miss 更少
  * 缺点：
    * 实现稍微复杂一些
    * 不容易做一些算子的下推
* 还有一种方式就是用一个显式的 watchdog / scheduler 线程来调度，这个线程不做执行，专门来做调度，哪个算子能够执行，应该去哪个线程执行（线程和哪个 CPU 更亲和），都能够安排的明明白白的
  * 优点：
    * 更精细化的调度，对于各种计算中的 skew（例如一条 pipeline 中的 task 非常重，另一个空闲下来可以将任务调度过去） 能够做非常好的 schedule
    * 可以对于执行有全局视角，更容易做优化
  * 缺点：
    * 额外的调度 overhead
    * 实现更复杂一点

## parallel execution

提升执行效率另一个非常重要的点就是并行，在 pipeline 里面的并行分成两个方面的并行：

* 水平方向

  * 这里通常指将一个完整的 range 的数据水平切几刀，然后分成多个 pipeline 去执行这一小部分数据，最终再聚合起来，类似 map reduce，每个 pipeline 只有一部分数据

* 竖直方向

  * 用前面 ck 的图举例，对于一个很长的 pipeline，可以同时执行一条 pipeline 上的多个算子，例如

  * ```
    source1 -> transform1 -> transform2 -> transform3 -> ...
    ```

    可以同时执行一条 pipe 上的 source1 算子和 transform2 算子，这就是所谓的竖直方向的并行

## NUMA-aware (data centric)

在现代的多核CPU架构中，由于 NUMA 架构的特点，不同CPU访问不同内存区域的速率有比较大的差异（通过 CPU socket 传输数据）。

所以希望能够尽可能以数据为中心，将针对同一条 pipeline 中的多个算子的都调度到同一个 CPU 上执行（CPU 亲和性），这样同一条 pipeline 上的多个算子所实际运行的 thread 都尽可能在同一个 CPU 上执行，所访问的数据也都在这部分 CPU 更近的内存中，会有更高执行效率。

## work-stealing / delay scheduling 

在 Pipeline 执行的时候，每个 pipe 中的任务执行上可能出现各种情形的 skew，虽然在 pipeline 开始水平切分的时候尽可能将数据进行了平均切分，但是通过每个算子之后，剩余的数据可能不同，例如通过一个 filter 算子之后，pipeline 中的两个 pipe 之间的数据出现了极度不均衡，例如下面这种情况，第一个 pipe 的 filter 之后只有 1% 的数据，那么很快这个pipe 就计算完毕了。

```
pipe1: source1 -> filter -- selectity: 1% ---> transform2 -> 


pipe2: source2 -> filter -- selectity: 99% ---> transform2 -> 


pipe3:  source3 -> filter -- selectity: 50% ---> transform2 -> 

...
```

在这种情况下，pipe1 就可以尝试 steal pipe3 中的 task queue 中的任务来执行，不让每个 CPU 闲置，提高 CPU 的利用率。

working stealing 的一个简单优化是 delay scheduling：有的时候并不需要立即去执行 working stealing，而是稍微等待一会，再去尝试拿任务，这种方式在工程实践上被证明是非常有效的，因为有的时候可能隔壁的 CPU 只是稍微慢了那么一点点，多等一下等ok了。

但是这个方式也不是绝对的，有的时候，work stealing 机制也会带来副作用，例如在 SAP HANA 中，他们提出，他们使用的机器有 256 nodes，这个时候 work stealing 反而会降低效率，因为需要从跨 numa 的 cpu socket 去更远的内存中拿到数据，work stealing 得不偿失。 

## complication

编译执行，在不少高性能的 AP 中有实现，例如：MS hekaton，sqlite，presto，pelton 等，实现的方式也是有多种：

* 手动改写成 C/C++ or 某种 DSL
*  JVM-based JIT
* LLVM-based

在 pipeline 中，当可以将任务表达成一个 DAG 之后，就可以编译生成机器代码执行，不再做显式的解释执行调度了。编译执行的效果很好，但是实现起来也通常比解释执行更加困难。

# 一个 naive 的实现

说了这么多，还没有介绍 pipeline 具体的实现是怎样的，在工业实践中，比较好的实现有

* [Clickhouse](https://github.com/ClickHouse/ClickHouse/tree/c2611c3ba940cedf7ddc225e805e45fd77c59977/src/QueryPipeline) ，[databend](https://github.com/datafuselabs/databend/tree/main/src/query/pipeline) ，[datafusion](https://github.com/apache/arrow-datafusion/tree/ac5676f74bfac89707642f9221d35899b7c2c321/datafusion/core/src/scheduler/pipeline)，[DuckDB](https://github.com/duckdb/duckdb/tree/88b1bfa74d2b79a51ffc4bab18ddeb6a034652f1/src/parallel)

感兴趣的读者可以自己阅读这些 pipeline 的实现。

我自己也简单实现一个的版本来学习 pipeline，并没有实现太多先进的特性，只是出于学习理解的目的实现一个基础的版本：https://github.com/Veeupup/naive-pipeline-execution

# 相关资料

* [MonetDB/X100: Hyper-Pipelining Query Execution](https://www.cidrdb.org/cidr2005/papers/P19.pdf)

* [Morsel-Driven Parallelism: A NUMA-Aware Query Evaluation Framework for the Many-Core Age](https://15721.courses.cs.cmu.edu/spring2019/papers/14-scheduling/p743-leis.pdf)

* [ClickHouse Query Execution Pipeline PPT](https://presentations.clickhouse.com/meetup24/5.%20Clickhouse%20query%20execution%20pipeline%20changes/)

  * [bilibili 搬运对应的演讲]( https://www.bilibili.com/video/BV147411U7A3/?vd_source=2be11642e5a095e9c7f08f3b64cc4b1a)

  * [Clickhouse CTO Alexey 解释 pipeline](https://github.com/ClickHouse/ClickHouse/issues/34045)

* [By 虎哥 ClickHouse和他的朋友们（4）Pipeline处理器和调度器](https://bohutang.me/2020/06/11/clickhouse-and-friends-processor/)

* [# ClickHouse 源码学习之Pipeline执行引擎](https://zhuanlan.zhihu.com/p/401658490) \

* [[OLAP 任务的并发执行与调度](https://io-meter.com/2020/01/04/olap-distributed/)](https://io-meter.com/2020/01/04/olap-distributed/)
