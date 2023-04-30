---
title: Dremel | A Decade of Interactive SQL Analysis at Web Scale
date: 2023-04-30 14:29:05
categories:
- 论文笔记
tags:
- 数据仓库
---

# History

google 内部有很多 Data Systems，每当 google 发布了他们系统的论文之后总会出现外部的一些开源版本，因为大家都认为 google 很成功，

NoSQL：

* MapReduce, 2004 -> Hadoop, Spark
* BigTable, 2005 -> HBase, Accumulo, Hypertable
* Chubby, 2006 -> Zookeeper, etcd

SQL:

* Megastore, 2010
* Vitness, 2010 -> Vitness, Planetscale
* Dremel, 2011 -> Drill, Impala, Dremio
* Spanner, 2011 -> CockroachDB, TiDB
* F1, 2013
* Mesa, 2014
* Napa, 2021

# Architecture

最初在2006年作为一个 side-project 开发，用于分析从其他工具生成的数据文件。

* “interactive”目标意味着他们希望支持对原位数据文件进行即席查询。

* 第一版不支持 Join 操作。

在2010年代后期重写为基于GFS的共享磁盘架构。

2012年发布为公共商业产品（BigQuery）。

## In-SITU Data Processing

在共享存储（例如对象存储）中执行对数据文件的查询，以其原始格式进行操作，而无需首先将其 Ingest 到DBMS（即托管存储）中。

* 这就是人们通常所说的 Data lake。
* data lakehouse 是位于所有这些之上的DBMS。

目标是减少开始分析数据所需的准备时间。

* 用户愿意牺牲查询性能来避免重新编码/加载数据文件。

## 一些特性

* Shared-Disk / Disaggregated Storage
* Vectorized Query Processing
* Shuffle-based Distributed Query Execution
* Columnar Storage
  * Zone Maps / Filters
  * Dictionary + RLE Compression
  * Only Inverted Indexes
* Hash Joins Only
* Heuristic Optimizer + Adaptive Optimizations

## Query Execution

DBMS将逻辑计划转换为包含多个并行任务的 stage（pipelines）。

* 每个任务必须是确定性和幂等的，以支持重新启动。

根节点（协调器）检索批处理中目标文件的所有元数据，然后将其嵌入查询计划中。

* 避免了数千个工作进程同时访问分布式文件系统获取元数据。避免对 GFS 的压力太大
* 后面也提到可以通过合并成大文件来减少小文件的碎片

![image-20230430130519564](./dremel_query_exec.png)

# Shuffle

使用专用的节点从每个阶段传输中间结果的生产者/消费者模型。

* 工作节点将输出发送到 shuffle  节点。
*  shuffle  节点在内存中以哈希分区方式存储数据。
*  下一阶段的工作节点从 shuffle  节点检索其输入。

如果需要， shuffle  节点会将此数据存储在内存中，并仅溢出到磁盘存储。

![image-20230430130653795](./dremel_shuffle_pic.png)

 shuffle  阶段代表查询生命周期中的检查点，协调器确保所有任务都已完成。

**Fault Tolerance / Straggler Avoidance**：

* 如果一个工作节点在DDL内没有生成任务结果，则协调器会推测性地执行冗余任务。

**Dynamic Resource Allocation**：

* 根据阶段输出的大小，扩大/缩小下一阶段的工作节点数量。

# Query Optimization

我们讨论了查询优化器如何依赖从数据中提取的统计信息导出的成本模型。但是如果没有统计信息，DBMS如何优化查询呢？

* DBMS从未见过的数据文件。

* 来自其他DBMS（Connector）的查询API。

Dremel的优化器采用分层方法，使用基于规则和成本的优化器传递来生成初步物理计划以开始执行。

* 谓词下推、星型模式约束传播、主/外键提示、连接顺序等规则。
* 成本优化仅针对DBMS具有统计信息可用（例如，物化视图）的数据进行。

为避免坏成本模型估算带来的问题，Dremel使用动态查询优化

## Dynamic QUERY OPTIMIZATION

Dremel在阶段开始之前根据前一阶段的观察结果更改查询计划。

* 避免优化器使用不准确（或不存在）的数据统计信息做出决策的问题。

优化示例：

*  更改 stages 中 work nodes 的数量。
* 在Shuffle和Broadcast Join之间切换。
* 更改物理运算符实现方式。
* Dynamic repartitioning。

## Dynamic Repartition

Dremel动态负载平衡并调整中间结果分区以适应 data skew。DBMS检测到 shuffle  分区过于满时，然后指示工作人员调整其 partition 方案。

![image-20230430131202943](./dremel_repartition.png)

# Storage Format

DBMS依赖于Google的分布式文件系统（Colossus）来扩展存储容量。

依赖于Capacitor的列编码方案，用于嵌套关系和半结构化数据。

* 可以将其视为没有速度缓慢问题的JSON / YAML。
* Capacitor还提供了具有基本过滤功能的访问库，embedd 的一个 mini SQL 处理器，可以做一些 filter。
* 类似于Parquet vs. Orc格式。

重复和定义字段嵌入在列中，以避免检索/访问祖先属性。

![image-20230430123814485](./dremel_columnar_format.png)

> 可以看这篇文章了解具体的结构：
>
> * https://www.kancloud.cn/digest/in-memory-computing/202157
> * https://www.kancloud.cn/digest/in-memory-computing/202158

## SCHEMA REPRESENTATION

Dremel的内部存储格式是自描述的

* 数据库管理系统需要理解文件中包含什么，所有信息都在文件中。

但是每当DBMS想要读取一个文件时，它必须解析该文件的嵌入式模式。

* 表可以有数千个属性。大多数查询只需要属性子集。

DBMS以列格式存储模式，以减少检索元数据时的开销

# SQL

在2010年代初期，谷歌内部的许多DBMS项目都有自己的SQL方言。GoogleSQL项目统一了这些冗余的努力，构建了数据模型、类型系统、语法、语义和函数库。开源版本：ZetaSQL。

使用这些 SQL 的项目有 cloud spanner 等。

> The conventional wisdom at Google was “SQL doesn’t scale”, and with a few exceptions, Google had moved away from SQL almost completely. In solving for scalability, we had given up ease of use and ability to iterate quickly.
>
> Dremel was one of the first systems to reintroduce SQL for Big Data analysis.Dremel made it possible for the first time to write a simple SQL query to analyze web-scale datasets. Analysis jobs that took hours to write, build, debug, and execute could now be written in minutes and executed in seconds, end-to-end, allowing users to interactively write, refine and iterate on queries. This was a paradigm shift for data analysis. The ability to interactively and declaratively analyze huge datasets, ad hoc, in dashboards, and in other tools, unlocked the insights buried inside huge datasets, which was a key enabler for many successful products over the next decade
>
> Dremel 开始重新拥抱 SQL 的怀抱并且统一了 Google 的 SQL 前端。

# Serverless Computing

Dremel是提供弹性、多租户和按需服务的先驱之一，现在被广泛称为无服务器。

> 感觉 Snowflake 相似的云数仓都学习了 Dremel 的这种思想

## Serverless roots

大多数数据仓库（如IBM Netezza、Teradata和Oracle产品）在Dremel概念形成之时部署在专用服务器上，主要遵循数据库管理系统的模式。MapReduce和Hadoop等大数据框架采用了更灵活的部署模式，利用虚拟机和容器，但仍需要单租户资源配置即每个用户一个作业。

显然，在Google支持交互式低延迟查询和现场分析，并同时扩展到数千个内部用户且成本较低的情况下，只有通过提供按需资源配置的多租户服务才能实现。最初我们利用三个核心思想来实现无服务器分析：

1. 解耦：解耦计算、存储和内存允许按需缩放并独立共享计算而不受存储影响。因此它可以以更低的成本适应使用情况。正如第3节所述，Dremel从2009年开始将磁盘存储与计算资源解耦，并于2014年最终添加了解耦内存。

2. 容错性和可重启性：Dremel查询执行是基于底层计算资源可能缓慢或不可用这一假设构建的，使得工作者固有地不可靠。这种假设对查询运行时和调度逻辑有着强烈的影响：
   * 查询中的每个子任务必须是确定性和可重复的，以便在失败时只需重新启动另一个工作者上的一小部分工作。
   * 查询任务调度程序必须支持将多个相同任务副本分派到其他不响应的工作者上。

因此，这些机制使得调度逻辑可以轻松地通过取消和重新安排子任务来调整为查询分配的资源量。

3. 虚拟调度单元：Dremel调度逻辑设计为使用称为插槽（slots） 的计算和内存抽象单位而不是依赖于特定类型和形状的机器。这对容器导向Borg计算环境是一个很好匹配模型，该环境支持灵活资源配置形状。这些虚拟调度单元允许解耦服务部署、容器和机器形状以及客户可见资源配置与其之间关系，并继续成为BigQuery中资源管理核心客户可见概念。

原始Dremel论文中采用了这三种思想，在许多无服务器数据分析系统中成为构建块。行业和学术界广泛采用了解耦技术。Snowflake等其他提供商也采用了虚拟资源单元。在许多领域，行业已经趋于数据湖架构，使用弹性计算服务“按需”分析云存储中的数据。此外，许多数据仓库服务（如Presto、AWS Athena和Snowflake）也采用了按需分析或自动缩放作为无服务器分析的关键因素，导致许多企业选择云而不是本地系统。

## 5.2 **Evolution of serverless architecture**

Dremel继续发展其无服务器能力，使它们成为Google BigQuery的关键特征之一。原始Dremel论文中的一些方法演变成了下面描述的新思想，将无服务器方法提升到了一个新水平。

* *Centralized Scheduling*。2012年，Dremel转向集中式调度，这允许更精细的资源分配，并开放了预留功能，即为特定客户分配Dremel处理能力的一部分。 集中式调度取代了原始论文中负责在中间服务器之间分配资源的“dispatcher”。 新调度程序使用整个群集状态来进行调度决策，从而实现更好地利用和隔离。

* *Shufflfle Persistence Layer.*。在2010年论文发表后引入了Shuffle和分布式连接功能。 在最初的 shuffle 实现之后，架构演变为允许解耦查询不同阶段的调度和执行。 使用 shuffle 结果作为查询执行状态检查点时，调度程序具有动态抢占 work node  以减少资源配置以适应计算资源受限时其他工作负载需求等灵活性。

* *Flexible Execution DAGs.*。原始论文描述了图3所示系统架构。 固定执行树对于聚合运算效果良好，但随着Dremel的发展，固定树对于更复杂的查询计划并不理想。 通过迁移到集中式调度和Shuffle持久层，架构以以下方式改变：

  * 查询协调器是接收查询的第一个节点。它构建查询计划，可以是查询执行树（也称为阶段）的DAG，并使用由调度程序提供给它的 work node  编排查询执行。
  *  work node  被分配为没有预定义结构的池。一旦协调员决定执行DAG形状，就会向 work node  发送准备好执行本地查询执行计划（树）。叶子级别上来自存储层读取数据并写入Shuffle持久层；其他级别上来自/到Shuffle持久层读取和写入数据。完成整个查询后，在Shuffle持久层中存储最终结果，并将其发送给客户端。
  * 考虑图4中所示的示例，该示例说明了在Wikipedia表格上运行top-k查询时如何进行：
  * ![image-20230430132927022](./dremel_shuffle_based_execution.png)

  * 阶段1（叶子）中的工作人员从分布式存储器中读取数据、应用过滤器、局部预聚合数据然后按语言字段进行哈希分区 shuffle 。
  * 由于数据按聚合键 shuffle ，因此阶段2中的工作人员可以进行最终的GROUP BY聚合，然后按不同键排序、截断限制并将结果发送到下一个阶段。
  * 在第3个阶段中只有一个 work node  ；它从Shuffle持久层读取输入，进行最终排序和截断，并将结果写入Shuffle层。查询协调器从Shuffle持久层中读取最终的100条记录，并将其发送给客户端。
  * 任何Dremel查询（例如上面提供的示例）都可以在任意数量的工作人员上执行，范围从1到数万名工作人员。 Shuffle持久层提供了这种灵活性。

* *Dynamic Query Execution.*。基于数据形状，查询引擎可以应用多种优化。例如，考虑选择连接策略，如广播与哈希连接。广播连接不需要在连接探测端对数据进行 shuffle ，因此速度可能更快，但只有当构建侧足够小以适合内存时才能使用广播。
  * 通常，在查询计划期间获得准确的基数估计是困难的；众所周知，在联接中错误会指数级传播[27]。Dremel 选择了一条路径，在查询执行过程中根据收集到的统计信息动态更改查询执行计划。这种方法是通过 shuffle 持久层和由查询协调器进行集中式查询编排实现的。在广播与哈希连接方面，Dremel 将从哈希连接开始，并在两侧都进行 shuffle 处理，但如果一侧完成得很快并且低于广播数据大小阈值，则 Dremel 将取消第二次 shuffle 并改为执行广播连接。

# 其他优化

* *Stand-by server pool*。通过分布式SQL执行引擎，可以启动一个系统并准备好立即处理提交的查询。这消除了用户编写自己的MapReduce或Sawzall作业时存在的机器分配、二进制复制和二进制启动延迟。
* *Speculative execution*。当数百台机器处理一个查询时，最慢的工作者可能比平均值慢一个数量级。如果没有任何补救措施，则最终效果是用户端到端查询延迟高达一个数量级。为解决这个问题，Dremel将查询拆分成数千个小任务，在完成任务时每个工作者都可以接受任务。通过这种方式，慢速机器处理较少的任务而快速机器则处理更多的任务。此外，为了对抗查询执行结束时长尾延迟，Dremel可以针对滞后者发出重复任务，并降低总体延迟时间。因此性能成为可用资源总量而不是最慢组件功能。
* *Multi-level execution trees*。在几秒钟内使用数百台计算机来处理单个查询需要协调性能 。 Dremel使用具有顶部根服务器、中间服务器和叶子服务器的树形结构来解决这个问题。执行从根到叶子，然后返回。该模型最初是从Google的搜索借鉴而来。它很好地并行化了请求的分派和查询结果的组装。
* *Column-oriented schema representation*。Dremel的存储格式被设计为自描述，即数据分区存储嵌入式模式。在Google使用的模式通常包含数千个字段。解析完整模式可能比读取和处理来自分区的数据列更耗时。为了解决这个问题，Dremel内部架构表示本身以列格式存储。
* *Balancing CPU and IO with lightweight compression.*。使用列格式使压缩更有效，因为相似值（单个列的所有值）按顺序存储。这意味着必须从存储层读取较少字节，进而减少查询延迟时间 。另一方面 ，解压数据需要CPU周期 ，因此涉及越多 的 压缩 ， CPU成本就越高 。关键是选择一个平衡数据大小减小与CPU解压缩成本之间关系 的 压缩方案 ， 以便既不会出现CPU瓶颈也不会出现IO瓶颈。
* *Approximate results.* 。许多分析不需要100％的准确性，因此提供处理top-k和count-distinct的近似算法可以降低延迟。Dremel使用一次通过算法，这些算法与多层次执行树结构配合良好。此外 ， Dremel允许用户指定在返回结果之前要处理多少数据百分比 。由于滞后效应，在处理了98％的数据后返回结果已被证明可以将延迟时间提高2-3倍。
* *Query latency tiers.*。为了在共享服务器池中实现高利用率，Dremel必须本地支持多个用户同时发出多个查询。由于数据大小范围广泛，有些查询可以在几秒钟内完成，而其他查询可能需要数十秒钟的时间。为确保“小”查询保持快速，并且不会被具有“大”查询的用户阻塞，Dremel在中间服务器上使用调度程序公平地安排资源。调度程序需要能够抢占部分查询处理以允许处理新用户的查询，以避免先前的用户通过运行数百个并发查询来垄断资源的情况。即使是来自单个用户的查询也可能需要不同的优先级，例如支持交互式仪表板与执行每日ETL管道作业等任务。
* *Reuse of fifile operations.*。对于一个请求，在几秒钟内处理成千上万个文件将给分布式文件系统带来巨大负载压力。这实际上可能成为实现低延迟性能瓶颈所在之处：当数千台Dremel工作者向文件系统主节点发送元数据和向块服务器发送打开和读取操作时就会产生此问题。 Dremel采用了一些技术解决了这个问题：最重要的技术是通过从根服务器批量获取元数据并将其传递到叶服务器进行数据读取来重用从文件系统获得的元数据。另一种技术是创建更大的文件，以便可以通过较少的文件表示相同的表，从而减少了文件元数据操作。
* *Guaranteed capacity.*。在第5节中引入集中式调度程序时介绍了预留概念，这也有助于提高延迟性能。例如，客户可以预留一些容量，并仅将该容量用于对延迟敏感的工作负载。当未充分利用保证容量时，这些资源可供其他人使用；但是当请求这些资源时，则立即授予给客户使用。 Dremel工作者使用自定义线程调度程序，它会立即重新分配CPU以执行已预订任务并暂停非预订任务。
* *Adaptive query scaling.*。在第5节描述的灵活执行DAGs是改善不断增长和多样化工作负载下延迟性能的重要组成部分。根据查询计划为每个查询单独构建执行DAG可能很关键：考虑全局聚合（例如COUNT或SUM）：对于固定聚合树结构而言，在多个中间级别上需要进行多次跳转处理此类查询；但是采用灵活DAGs则无需超过两个聚合级别——叶子级别聚合输入并生成每个文件一个记录，而顶级则执行最终聚合。相反，考虑top-k查询（即ORDER BY ... LIMIT）：叶子阶段中的每个工作者都会产生许多记录。在具有大量输入的单个节点上进行最终聚合将成为瓶颈。因此，为了处理这种查询，Dremel动态构建一个聚合树，其深度取决于输入大小。

# Other Systems

自2011年VLDB论文以来，有一些数据库管理系统项目是Dremel的副本或灵感来源。

* Apache Drill
  * Drill是一个基于Hadoop的Dremel开源实现。该项目始于2012年在MapR公司。支持通过Janino嵌入式Java编译器进行查询代码生成。惠普企业宣布他们将不再支持Drill的开发工作，时间为2020年。
* Dremio
  * 基于Apache Arrow，灵感来自Dremel的开源/商业DBMS。由CMU校友于2015年开始。
  * 利用用户定义的物化视图（“反射”）加速对外部数据文件的查询执行。
  * 还依赖于基于Java的codeghen和向量化。
* Apache Impala、
  * Impala是受Dremel启发的另一个分布式文件系统上执行查询的DBMS。
  * 由前Google数据库人员于2012年在Cloudera开始开发。
  * 支持过滤器和解析逻辑的代码生成。
  * 将执行器组件放置在每个数据节点上以提供解析和谓词下推。

还有[Apache Uniffle](https://uniffle.apache.org/)（腾讯）提供分布式 shuffle 服务。

# 总结

Dremel是一种创新的DBMS，早于所有其他主要的云原生OLAP DBMS。shuffle 阶段似乎很浪费，但它简化了工程，并可以提高性能。这也是将DBMS组件分解为单独服务以抽象原始资源好处的一个很好的例子。

解耦了计算、内存、存储，元数据存储，在现代云计算时代的先驱。

# 参考资料

* [15-721 spring 2023](https://15721.courses.cs.cmu.edu/spring2023/slides/19-bigquery.pdf)
* [Dremel: A Decade of Interactive SQL Analysis at Web Scale](https://15721.courses.cs.cmu.edu/spring2023/papers/19-bigquery/p3461-melnik.pdf), in *VLDB*, 2020
* [Dremel: Interactive Analysis of Web-Scale Datasets](https://15721.courses.cs.cmu.edu/spring2023/papers/19-bigquery/melnik-vldb10.pdf), in *VLDB*, 2010 *(Optional)*
* https://www.kancloud.cn/digest/in-memory-computing/202157
* https://www.kancloud.cn/digest/in-memory-computing/202158



