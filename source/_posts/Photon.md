---
title: Databricks Photon | Native C++ Query Engine for Lakehouse Systems
date: 2023-04-30 18:48:52
categories:
- 论文笔记
tags:
- 数据仓库
---

# History

## Spark 简介

来自伯克利的高性能和更具表现力的 Hadoop 替代品。

* 计算/存储分离
* 支持对同一数据集进行多次迭代算法。

使用 Scala 编写，可以在 JVM 上运行。

最初只支持 low-level 的 RDD API，后来添加了 DataFrame API 以实现更高级别的抽象。

## SHARK （2013）

Facebook的Hive中间件的修改版本，将SQL转换为Spark API程序。

仅支持在Hive目录中注册的数据文件上运行SQL。Spark程序无法在API调用之间执行SQL。

Shark依赖于Hive查询优化器，该优化器专为在Hadoop上运行map-reduce作业而设计。

* Spark具有更丰富的本地API功能

## Spark SQL （2015）

基于行的SQL引擎原生地嵌入Spark runtime 里面， Spark SQL 将使用基于Scala的 query codegen。

* 以原始字节缓冲区为中间结果的内存列式表示
* Dictionary encoding, RLE, bitpacking compressions
* 查询阶段之间的内存 shuffle

DBMS将查询的WHERE子句表达式树转换为Scala AST。然后它编译这些AST以生成JVM字节码。

## JVM Problems

Databricks的 workload 是 CPU bound 的。

* 由于 NVMe SSD 缓存和自适应的 shuffle，disk stall 减少了。
* Better filtering to skip reading data

他们发现很难进一步优化基于JVM的Spark SQL执行引擎：

* 对于大于64GB的堆而言，GC会很慢
* 针对大型方法，JIT代码生成存在局限性

# Architecture

## DataBricks Photon（2022）

photon 是 databricks 为了增强 spark 计算而写的 Native C++ 计算引擎，通过 JNI 和 JVM 进行结合，实现了spark的向量化处理、微批adaptivity，与已有DBR和spark兼容。

一些特点：

* Shared-Disk / Disaggregated Storage
* Pull-based Vectorized Query Processing
* Precompiled Primitives + Expression Fusion
* Shuffle-based Distributed Query Execution
* Sort-Merge + Hash Joins
* Unified Query Optimizer + Adaptive Optimizations

## Query Execution

![image-20230430180259757](databricks_query_exec.png)

> 和 Dremel 区别是没有 dedicated shuffle nodes

## Photon: Vectorized Query Processing

每次在 Photon 操作符上调用 GetNext 都会生成 column batch。

* 一个或多个带有 position list vectors的 column vectors。
* 每个列向量都包括空位图。

Databricks：与间接引用相比，“位置列表向量”表现更好。

![image-20230430180733503](databricks_photon_getnexr.png)

Photon不支持HyPer风格的操作符融合，以便DBMS可以收集每个操作符的metrics，帮助用户了解查询行为。

* 在 pipeline 中对多个操作符进行 vertical fusion。

相反，Photon的工程师会融合表达式来避免过多的函数调用。

* Horizontal fusion within a single op

> 相当于某种程度上的编译查询，将多个 primitive operator 组合起来，防止过多的函数调用

下面是 hyper 的 operator fusion：

![image-20230430181023303](databricks_hyper_operator_fusion.png)

下面是 vectorwise 的 precompiled primitives

![image-20230430181143547](databricks_vectorwise_precompiled.png)

## Memory Management

所有的内存分配都会进入由JVM中的DBR（databricks runtime）管理的内存池

* Single source of truth for runtime memory usage

因为没有数据统计，所以DBMS在其内存分配方面必须更加动态

* Opera 不再将自己的内存 spill out 到磁盘上，而是向 manager 请求更多内存，然后管理员决定释放哪些 operator 的内存

* 简单启发式算法从已分配最少但足以满足请求的操作员中释放内存

## Catalyst Query Optimizer

Spark SQL 的 Cascades-style query optimizer ，用Scala编写，在pre-defined stages执行转换，类似于Microsoft SQL Server。三种类型的转换：

* **Logical* Logical** ("Analysis & Optimization Rules")
* **Logical* Physical** ("Strategies")
* **Physical* Physical** ("Preparation Rules")

## **PHYSICAL PLAN TRANSFORMATION**

从下往上遍历原始查询计划，将其转换为新的 Photon 特定物理计划。

* New Goal: Limit the number of runtime switches between old engine and new engine.

![image-20230430181638258](databricks_photon_phy_plan.png)

# ADAPTIVITY

## RUNTIME ADAPTIVITY

**Query-Level Adaptivity (更宏观一点)**

*  在每个shuffle 阶段结束时重新评估查询计划决策。

*  类似于我们上一节课讨论的 Dremel 方法。
*   这由 DBR wrapper 提供。

**Batch-Level Adaptivity (更微观一点)**

*  operator 内部的专用代码路径，以处理单个 tuple batch 的内容。
*  这是在查询执行期间由 Photon 完成的。

## Spark: Dynamic Query Optimization

Spark在阶段开始之前根据前一阶段的观察结果改变查询计划。

* 避免优化器使用不准确（或不存在）的数据统计信息做出决策的问题。

> 大家都学聪明了，刚开始没有统计信息的时候不好做优化，等执行过程中有了统计信息再来做优化…

优化示例：

* Dynamically switch between **shuffle vs. broadcast join**.
*  Dynamically **coalesce partitions**
  * 先分配足够数量的 partitions，这个时候某些 partition 可能比较小，等这个过程全部结束，再来合并小的 partitions，
* Dynamically **optimize skewed joins**

## PHOTON: BATCH-LEVEL ADAPTIVITY

将ASCII和UTF-8数据分开处理

* ASCII编码的数据始终是1字节字符，而UTF-8数据可以使用1到4字节字符。

**No NULL values in a column vector**

* 省略检查空向量的分支

**No inactive rows in column batch**

* 省略位置列表中间查找

# BenchMark

用 C++ 重写带来的提升太猛了。。当然也不只是语言的功劳……

![image-20230430182329828](databricks_bench_tpch.png)

# Delta Lake

缺乏统计数据使得对数据湖上的查询优化更加困难。适应性在某些方面有所帮助，但如果DBMS了解数据，它总是可以做得更好。如果有一个存储服务支持增量变化以便于DBMS计算统计信息会怎么样呢？

## Delta Lake（2019）

> 可以看这篇文章[Delta Lake](http://tanweime.com/2021/11/17/%E8%AE%BA%E6%96%87%E7%BF%BB%E8%AF%91-Delta-Lake-High-Performance-ACID-Table-Storage-over-Cloud-Object-Stores2/)

Delta Lake 提供了基于对象存储的 structured data incremental ingestion Transactional CRUD接口。

DBMS将写入记录到到面向 JSON 的日志中。后台工作程序定期将日志转换为Parquet文件（带有计算统计信息）。

## Kudu（2015）

分布式文件系统中，用于结构化数据文件  low-latency random access 的存储引擎。

* 2015年在Cloudera开始，以增强 Impala。

无SQL接口（必须使用Impala）。仅支持低级CRUD操作。

# 参考资料

* [Andy 15-721](https://15721.courses.cs.cmu.edu/spring2023/slides/20-databricks.pdf)
* [photon paper](https://15721.courses.cs.cmu.edu/spring2023/papers/20-databricks/sigmod_photon.pdf)
* [delta lake paper](https://15721.courses.cs.cmu.edu/spring2023/papers/20-databricks/p975-armbrust.pdf)
* 建议看看：[论文解读 Photon: A Fast Query Engine for Lakehouse Systems](https://zhuanlan.zhihu.com/p/511400714)
