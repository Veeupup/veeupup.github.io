---
title: DuckDB 整体介绍
date: 2023-05-02 17:42:45
categories:
- DuckDB
tags:
- 数据仓库
---

# DuckDB

## What is DuckDB

DuckDB 是一个 In-Process 的 OLAP 数据库，可以理解为 AP 版本的 SQLite，采用 MIT 协议开源，是荷兰 CWI 数据库组的一个项目，学术气息比较浓厚，项目的组织很有教科书的感觉，架构很清晰，所以非常适合阅读学习。

## Why DuckDB come out

[CWI 数据库组](https://www.cwi.nl/en/groups/database-architectures/)非常厉害，像 MonetDB、Vectorwise 都是该组出来的项目。所以在该组早期推出过一个 MonetDBLite 的项目用于嵌入式的数据分析，这是一个基于 MonetDB 实现了想要的 In-Process 的 OLAP，这个过程中发现搞边缘计算 AP 分析很有市场，也发现了做嵌入式AP数据库的各种要求和限制，所以才开始做 DuckDB。

下面是 DuckDB 团队发现对于嵌入式 In-Process OLAP 的一些要求，并尝试解决它们：

* 组合 OLAP 和 ETL 的 workload：能够处理 AP workload 的同时不完全牺牲 OLTP 的性能，同时有效支持批量 append 和批量 update。
* 传输效率：需要很方便的在 application 和 DBMS 之间传递数据，因为不是所有任务都能在嵌入式数据库中完成，例如机器学习、画图等，所以需要很方便的在 DBMS 和 application 之间传递数据。而由于 In-Process OLAP 的好处是在同一地址空间内，可以非常方便的来传递数据。
* 弹性（Resilience）：边缘计算的 OLAP 所在的硬件和服务器级别的硬件差别非常大而且各异，更容易出现硬件问题，嵌入式DBMS要能够检测这些问题并防止数据损坏
* Cooperation：系统需要优雅地适应资源争用（CPU or RAM），由于嵌入式数据库不再是机器的唯一使用者，因此它不能像以前那样持续使用所有硬件，否则会导致底层应用程序资源匮乏

# Architecture Overview

先来看一个整体的架构图：

> 来自 Mark 的 15721 slide

![image-20230501182908424](overview.png)



DuckDB 各个组件之间的架构非常的 "textbook"，也就是说会把整个数据库分为：**Parser, logical planner, optimizer, physical planner, execution engine，transaction and storage managers**。

作为嵌入式数据库，DuckDB没有客户端协议接口或服务器进程，而是使用C/C++ API进行访问。此外，DuckDB提供了SQLite兼容层，允许以前使用SQLite的应用程序通过重新链接或库 overload 来使用DuckDB。

* Parser
  *  SQL Parser 源自 Postgres SQL Parser

* Logical Planner 
  * binder， 解析所有引用的 schema 中的对象（如 table 或 view）的表达式，将其与列名和类型匹配。
  * plan generator，将 binder 生成的 AST 转换为由基本 logical query 查询运算符组成的树，就得到了一颗  type-resolved logical query plan。 DuckDB 还保留存储数据的统计信息，并将其作为规划过程中不同表达式树的一部分进行传播。这些统计信息用于优化程序本身，并且也用于防止整数溢出

* Optimizer
  * 使用动态规划进行 join order 的优化，针对复杂的 join graph 会 fallback 到贪心算法
  * 会消除所有的 subquery
  * 有一组 rewrite rules 来简化 expression tree，例如执行公共子表达式消除和常量折叠。
  * Cardinality estimation 是使用采样和`HyperLogLog` 的组合完成的，这个过程将优化 logical plan。
  * physical planner 将 logical plan 转换为 physical plan，在适用时选择合适的实现方式，例如 sort-merge join or hash join。

* execution engine
  * DuckDB 最开始采用了基于 Pull-based 的 `Vector Volcano` 的执行引擎，后来切换到了 Push-based 的 pipelines 执行方法
  * DuckDB 采用了向量化计算来来加速计算，具有内部实现的多种类型的 vector 以及向量化的 operator
  * 另外出于可移植性原因，没有采用 JIT，因为 JIT引擎依赖于大型编译器库（例如LLVM），具有额外的传递依赖。
* Transactions: 
  * DuckDB 通过 MVCC 提供了 ACID 的特性，实现了[HyPer专门针对混合OLAP / OLTP系统定制的可串行化MVCC 变种](https://db.in.tum.de/~muehlbau/papers/mvcc.pdf) 。该变种立即 in-place 更新数据，并将先前状态存储在单独的 undo buffer 中，以供并发事务和 abort 使用

* Persistent Storage
  * 单文件存储
  * DuckDB 使用**面向读取优化**的 DataBlocks 存储布局（单个文件）。逻辑表被水平分区为 chunks of columns，并使用轻量级压缩方法压缩成 physical block 。每个块都带有每列的`min/max` 索引，以便快速确定它们是否与查询相关。此外，每个块还带有每列的轻量级索引，可以进一步限制扫描的值数量。

 vector, execution, storage 多做一些介绍，其他部分暂时略过…

# Vectors

DuckDB 内部是一个 **vectorized push-based model**，在执行过程中，vector 会在各个操作符之间流转，而不是一个个 tuple。

DuckDB 具有非常多自定义的  vector format，非常类似 Arrow，但是对于执行更加友好，是和 volox team 一起设计的，所以很 volex team 的 vector 有很多相似之处。

每个 vector 只保存单个类型的数据，这里有 logical array 和实际物理实现的区别，对外的操作符看来就是一致的 logical array。

可以看到下面举例了四种类型的 vector，各自都有自己的逻辑和物理表达形式。

![image-20230502113453116](duckdb_vector_1.png)

而为了统一起来上层访问不同类型的 vector（避免 operator 算子处理不同 vector 时出现组合爆炸等问题），DuckDB 使用了一种统一的访问格式去访问底层不同的物理格式，也就是新增了一个 selection 数组，通过 DATA 和 Selection 去访问一个数据（类似 dictionary vector 结构）：

![image-20230502162914316](duckdb_vector_unified.png)

在针对字符串的额存储的时候，DuckDB 针对长短字符串做了不同的格式优化，短字符串直接 inline 存储，长字符串保存 4 byte 的prefix，另外保存一个 8 byte 的 pointer 指向剩下的内容。

> 保存 4 byte 的 prefix 有利于在比较字符串的时候提前进行比较

![image-20230502163259475](duckdb_string.png)

作为一款现代的 OLAP， DuckDB 也支持非结构化的类型存储，包括了 `struct` 和 `list` 这两种结构的 native 存储，DuckDB 不是直接存储 BLOB 或者 JSON 格式，而是使用已有的 vector 去递归表示两种结构。

像 Struct 包含了三个 vector 去表达一个 struct 结构，list 通过 offset 和 length 去表达 list 中的每一个元素。

这样可以直接利用已有的高性能算子去计算 nested type 的计算，而不是单独开发一套新的针对结构化类型的算子。

![image-20230502163655601](duckdb_nested_types.png)

# Execution

最开始 DuckDB 采用 pull-based 的执行引擎，每个算子都实现了 `GetChunk` 算子，非常经典的 valcano 模型。

在这个模型中，单线程执行是非常自然的，多线程并行的能力不是很好；在 volcano 模型下，DuckDB 实现并行的方式是添加了一个 `Exchange Operator`，由优化器将执行计算分成多个 partition，每个partition内部的执行仍然是单线程的 pull-based 的执行，不感知并行，通过 `Exchange` 算子将多个并行执行的算子的结果给组合起来。

![image-20230502164422656](duckdb_exec_pull_exec.png)

这么做有不少问题：

* 优化器在做 plan explosion 的时候很难找到最好的 plan，因为需要感知并行，来做不同的 partition 切分
* 就算找到了合适的 plan 去执行，在真正执行的过程中不同 partition 之间容易出现 data skew 的情况
* 另外还有就是中间结果物化的成本，例如在 `Exchange Operator` 执行的时候需要将下面的执行结果给物化下来

在 2021 年 DuckDB 切换到了 push-based 的执行引擎，并采用了 Morsel-Driven 的并行实现方式。

> [Move to push-based execution model #1583](https://github.com/duckdb/duckdb/issues/1583)
>
> [Push-Based Execution in DuckDB - Mark Raasveldt](https://www.youtube.com/watch?v=MA0OsvYFGrc)

DuckDB 会将一个 plan 切分成多个 pipeline，每个 pipeline 采用 push-based 的方式进行数据传递和调用。

DuckDB 在实现 push-based 的执行引擎时，将不同的算子抽象成三种类型 `Source`，`Operator` 和 `Sink`，其 `Source` 和 `Sink` 能够感知到全局状态以及并行，中间的每个 `Operator` 算子都是不感知并行，只是做计算。

> 可以参照[这篇文章了解 pipeline](https://zhuanlan.zhihu.com/p/614907875) 

![image-20230502165931398](duckdb_pipeline.png)



pull-based 的执行的控制流其实隐含在函数调用中（非常灵活和方便），但是 push-based 的执行能够显式的去控制执行流，而不是只靠函数调用，也就是说 push-based 的控制流由 DuckDB 手动控制，有很多好处

* 可以进行更多优化，因为了解每个算子的执行状态
  * vector cache，在不同的 operator 之间增加小的 cache，更加 cache friendly 去执行
  * scan sharing，每个算子可以将数据发送到多个算子中去，可以有多个 output
  * backpressure，因为了解了全局状态，可以设定一个 buffer size，在buffer 不够的时候暂停执行，有了足够空间再次执行
  * async IO，当算子执行 blocking IO 操作的时候暂停执行，等有了数据再继续执行

# Storage

DuckDB 采用了 single-file block-based 的存储格式，WAL 写到了另外一个文件中，通过 header 来实现了 ACID， 每个 block 是 4K 的大小。

![image-20230502170753542](duckdb_storage_block.png)

每张表存储的时候会先水平切分成不同的 row group（每个大约 120K~ rows），每个 row group 内部的存储是列存的格式。

![image-20230502171223613](duckdb_storage_table.png)

在每个 row group 内部的列存的时候 DuckDB 使用了压缩技术，可以提升 IO 的速度，同时加速执行（vector 中的一些类似方法）。

compression 能够让数据变得更小同时加速 query。

> 有两种类型的压缩：
>
> * General-purpose, 重量级压缩
>   * gzip, zstd, snappy, lz4
>   * 寻找 bits 中的 pattern 压缩
>   * 优点
>     * 实现简单
>     * 压缩率很高，空间占用很小
>   * 缺点
>     * 高压缩率会降低执行时候的速度，CPU 花时间解压
>     * 需要整个解压缩，不能只读取部分或者 seek
> * Special purpose, 轻量级压缩
>   * RLE, bitpacking, dictionary, FOR, delta
>   * 寻找 data 中的 pattern
>   * 优点
>     * 非常快
>     * 在执行的时候能够发现某个 pattern
>   * 缺点
>     * 如果找不到 pattern，那么就不能压缩
>     * 需要实现不同的压缩算法

DuckDB 团队采用了轻量级的压缩方案，在执行的时候寻找 pattern。

压缩的粒度会在 row group 中的 column 级别上进行，整个过程分成两步：

1. Analyze，找到最合适的压缩方法
2. Compress，采用该压缩方法进行压缩

![image-20230502171838768](duckdb_compression.png)

# Others

这里留下一些坑，以后再学习 DuckDB 的过程中仔细学习再写博客总结。

## Buffer Manager

DuckDB 的 buffer manager 是 lock-free 的（类似[Lean Store ](https://db.in.tum.de/~leis/papers/leanstore.pdf)），粒度是 256KB 的级别，实现了下面这些功能：

* 限制内存使用量
* 当计算需要的时候 pin blocks 在内存中
* 当不需要的时候 unpin blocks

## Out-Of-Core

DuckDB 支持在  **larger-than-memory execution**，因为是嵌入式 OLAP，所以需要考虑资源不够的情况。

* streaming engine
* 当内存不够的时候从 hash join -> sort merge join ，或者是一些 window 算法

目标是为了达到优雅的性能下降，避免性能的急剧下降

> 记得在哪看过这句话：“稳定的慢要比不稳定的快” 更好……

## Transactions

DuckDB 实现了 ACID 特性的事务，[基于 Hyper 的 MVCC 模型](https://db.in.tum.de/~muehlbau/papers/mvcc.pdf)，而且特别为了 vector processing 做了优化，DuckDB 支持到了 snapshot isolation 的隔离级别，采用了乐观的并发控制，如果修改了相同的行，那么就会 abort 当前的 transaction。

![image-20230502172541708](duckdb_mvcc.png)

## External Formats

DuckDB 还支持了直接从很多其他的格式中进行查询：Parquet, CSV, JSON, Arrow, Pandas, SQLite, Postgres, 

##  Pluggable Catalog

DuckDB 能够支持直接 attach 不同数据库作为自己的 catalog 执行。

## Pluggable File System + HTTP/Object Store Reads

DuckDB 有一个可插拔的文件系统，能够直接从 HTTP/S3/Object store 中来做查询。

## Extensions

DuckDB 支持很多不同的插件，能够通过 INSTALL 和 LOAD来进行开关，可以使用 shared library 的方式进行加载。

很多核心特性都是通过插件来实现的，例如：time zone, json, sqlite_scanner 等…

## WASM

DuckDB 还有一个 WASM 的build，可以直接在浏览器中进行查询。

# references

* [Mark Raasveldt Talk at CMU 15721](https://www.youtube.com/watch?v=bZOvAKGkzpQ&list=PLSE8ODhjZXjYzlLMbX3cR0sxWnRM7CLFn&index=22), with [slides](https://15721.courses.cs.cmu.edu/spring2023/slides/22-duckdb.pdf)
* M. Raasveldt, et al., [DuckDB: an Embeddable Analytical Database](https://15721.courses.cs.cmu.edu/spring2023/papers/22-duckdb/2019-duckdbdemo.pdf), in *SIGMOD*, 2019
* M. Raasveldt, et al., [Data Management for Data Science Towards Embedded Analytics](https://15721.courses.cs.cmu.edu/spring2023/papers/22-duckdb/p23-raasveldt-cidr20.pdf), in *CIDR*, 2020
* [Move to push-based execution model #1583](https://github.com/duckdb/duckdb/issues/1583)
* [Push-Based Execution in DuckDB - Mark Raasveldt](https://www.youtube.com/watch?v=MA0OsvYFGrc)
* [pipeline执行引擎和一些工程优化](https://zhuanlan.zhihu.com/p/614907875) 
* [Lean Store ](https://db.in.tum.de/~leis/papers/leanstore.pdf)
* [基于 Hyper 的 MVCC 模型](https://db.in.tum.de/~muehlbau/papers/mvcc.pdf)
