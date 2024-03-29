---
title: SIGMOD'18 | Column Sketches
date: 2023-02-09 23:55:12
categories:
- 论文笔记
tags:
- 数据仓库
---

# 要点总结

论文原文：

* [Column Sketches: A Scan Accelerator for Rapid and Robust Predicate Evaluation](https://15721.courses.cs.cmu.edu/spring2023/slides/04-olapindexes.pdf)

> 发现看论文越来越快了，确实是熟能生巧，今天花了大概两个小时读了一篇+笔记，确实对于一般的论文，自己也不需要深究太多证明和实现的细节，先整体了解一些思路即可，之后有需要再看具体的细节证明

本文的贡献：

* 本文提出一种新的索引方案，称为 Column Sketch，它提高了各种 workload 下的 predicate evalution  的性能
* 介绍了如何使用有损压缩来创建信息位表示，同时保持较低的内存开销
  * 主要第三章，看图就大概懂了
* 提供了在 Column Sketch 上进行高效 scan   的算法（结合SIMD指令加速的帮助），给出了 Column Sketch 性能模型
* 通过分析和实验证明，Column Sketches 将数值数据的 scan   性能提高了 3~6 倍，分类数据的 scan 性能提高了 2.7 倍

# Abstract

虽然已经开发了许多索引和存储方案来解决数据系统中 predicate evalution 的核心功能，但它们都需要特定的 workload 属性（query selectivity、data distribution、data-clustering）以提供良好的性能，并在其他情况下的性能不好. 我们提出了一种**新的索引方案，称为 Column Sketch，它提高了独立于 workload 属性的 predicate evalution  的性能**。 Column Sketches 主要通过使用有损压缩方案来工作，这些方案旨在使索引快速摄取数据，高效地评估任何查询，并且内存占用量小。 Column Sketch 通过在逐个值的基础上应用这种有损压缩来工作，将base data 映射到较小的fixed-width codes的表示。 使用压缩数据对绝大多数值的查询进行计算，并且仅在需要时检查基础数据中的剩余值。 Column Sketch 适用于列、行和混合存储布局。

本文证明，通过使用 Column Sketch，现代分析系统中的选择运算符比最先进的存储和索引方案获得更好的 CPU 效率和更少的 data movement。 与标准 scan   相比，Column Sketches 为 numerical attributes 提供了 3×-6× 的改进，为 categorical attributes 提供了 2.7× 的改进。 与 Column Imprints 和 BitWeaving 等最先进的 scan   加速器相比，Column Sketches 的性能提高了 1.4 - 4.8 倍。

# 1 Introduction

**Modern Data Access Methods**: 基础数据访问和谓词评估方法对分析数据库性能至关重要。 事实上，由于每个查询都需要索引或全表 scan   ，因此选择运算符的性能可作为系统性能的基准。 因此，存在无数的方法和优化来增强谓词评估。 尽管已完成大量工作，但现有的访问方法在某些情况下都表现不佳。 图 1 显示了一个示例，其中从传统索引（如 B 树）到 scan   加速器（如 Zone Maps和 BitWeaving ）的不同类别的访问方法没有带来任何优于普通 scan   的改进。 在本节中，我们使用图 1 来讨论最先进的索引和 scan   加速器方法的性能特征，并使用它们的性能来对比 Column Sketches。

![image-20230209212425975]( col_sketch_1.png)

**Traditional Indexes: ** 作为数据库系统的长期样例，传统的二级索引（例如 B 树）将数据访问定位到感兴趣的元组，从而为包含低选择性谓词的查询提供出色的性能。 然而，一旦选择性达到中等水平，B 树的性能就明显比其他方法差。 图 1 显示了这样一个具有 3% 低选择性的示例。

为了在高选择性查询上实现其性能，B 树引入了几个固有的缺点。 

首先，传统索引按照域的顺序而不是表的顺序查看数据。 因此，它们的输出留下了一个选择：要么按表的顺序对索引的输出进行排序，要么继续执行其余的查询，查看乱序的值。 其次，排序的顺序索引需要 gap，如 B 树的非完整叶节点的形式，用于新插入以分摊更新成本。 （二级索引 -> 聚簇索引 会变成随机查找）

其次，这些 gap 需要在谓词评估期间在内存中跳转，不断中断处理器，以便它可以等待数据。 这两者都与现代 scan   形成对比，现代 scan   依赖于对内存中连续数据的紧密循环比较，并按表的顺序查看数据。 

第三，传统索引的更新分散在它们的整个域中，因此不能与许多分析数据库运行的 append-only 的系统很好地交互。 此外，最近的变化，例如存储布局从面向行到面向列的变化以及内存容量的增加，使得传统 scan   相对于传统索引具有更高的性能。 在 1% 的 selectivity 的上，scan 比 B-tree 的查询效率更高。

**Lightweight Indices: ** 最近，轻量级索引技术对 scan   性能产生了影响。 这些技术主要用作在进行按顺序 scan   时跳过数据的方法。 zone map 是当今使用最广泛的技术之一，它通过存储少量元数据（例如数据块的最小值和最大值）来工作。 这种少量的元数据利用了数据中的 natural clustering 的属性，并允许 scan   跳过完全 ok 或者完全不符合 的 block。 Column Imprints  或 Feature Based Data Skipping 等其他技术采用更复杂的方法，但高级思想是相同的：它们使用数据组的汇总统计来启用 data skipping。 虽然在正确的情况下非常有用，但在数据不表现出聚类属性的一般情况下，对数据组使用汇总统计的方法没有帮助。 图 1 显示了这种情况，其中列的值与其位置无关； 那么， zone map 没有任何优势，有和没有 zone map 的 scan   性能是一样的。

**Early Pruning Methods: ** Byte-Slicing, Bit-Slicing , and Approximate and Refine 等早期 prune 方法通过按位分解数据元素来工作。 在物理层面上，这意味着将单个值分成多个子值，沿着每个位、每个字节或沿着任意边界。 在对数据进行物理分区后，每种技术都对值进行谓词并将谓词分解为不相交的子谓词的连接。 例如，检查一个两字节数值是否等于 100 等同于检查高位字节是否等于 0 且低位字节是否等于 100。将谓词分解为不相交的部分后，每种技术都会评估谓词按照最高位到最低位的顺序，如果某些块中的元组组都确定为合格或不合格，则跳过评估顺序中后面的谓词的谓词评估。 如果高位字节中的数据提供信息，则会跳过大量数据，但是这些技术可能会受到 data-skew 的影响。 例如，继续上面的例子，如果高阶字节的重要部分的值为 0，那么第一个字节的谓词在很大程度上是无信息的，而第二个字节的谓词几乎总是被评估。 这就是图 1 的情况； 高阶位偏向于零，使得剪枝非常少。 因此，与传统 scan   相比，早期修剪并没有带来明显的优势。

**Rapid and Robust Indexing via Column Sketches: ** 我们提出了一种新的索引方案，Column Sketches，与现有技术不同，它对选择性、数据值分布和数据聚类具有鲁棒性。 Column Sketches 通过在逐个值的基础上应用有损压缩来创建辅助代码列，这是基础数据的“草图”。 然后，谓词评估被分解为 (1) 对草图数据的谓词评估，以及，如果有必要，(2) 对来自基础数据的少量数据的谓词评估。

**Lossy Compression: **通过使用有损而不是无损压缩，Column Sketches 同时实现了三个主要目标。 

1. 首先，有损压缩允许高效地找到使 code schemes 始终提供信息的编码方案。 
2. 其次，有损压缩保证了在节省空间的同时可以实现信息编码，生成的 Column Sketch 明显小于基础数据。
3.  第三，有损压缩允许比基于无损编码技术的索引更快的摄取速度。 这是因为生成的代码很小，因此存储从值到代码的映射所需的结构也很小，从而使从值到代码的转换速度很快。 同样，与字典压缩等无损编码相比，有损压缩意味着此映射不需要是单射的，因此域中的新值不会导致 Column Sketch 重写旧代码值。

**Technical Distinctions: **Column Sketches 通过在关键方面不同于过去的技术来实现强大的性能。 与传统索引相反，数据按表的顺序显示，而不是按域的顺序显示。 压缩的辅助列位于连续的内存地址中，因此不会发生 pointer chasing。 与轻量级索引相比，Column Sketches 在逐个值的基础上工作，即使当值组混合满足和不满足谓词的值时，也允许跳过数据。 与 early prune 方法相比，有损压缩与物理布局紧密结合，以确保快速谓词评估和摄取速度。 现代 scan   中使用的其他最先进的加速技术，例如 SIMD、多核和 scan   共享，适用于 Column Sketches。 这是因为 Column Sketches 的核心是对一列 code 采用顺序 scan   。 结果如表 1 所示，其中 Column Sketches 为所有场景中的相等查询和范围查询提供了性能优势。 贡献。 本文的贡献如下：

1. 我们介绍了 Column Sketch，这是一种用于加速 scan   的数据结构，它使用有损压缩来提高性能，而不管selectivity, data-value distribution, and data clustering (§2)。
2. 我们展示了如何使用有损压缩来创建信息位表示，同时保持较低的内存开销（§3）。
3. 我们提供了在 Column Sketch 上进行高效 scan   的算法（§4），给出了 Column Sketch 性能模型（§5），并展示了 Column Sketches 如何轻松集成到现代系统架构中（§6）。
4. 我们通过分析和实验证明，Column Sketches 将数值数据的 scan   性能提高了 3~6 倍，分类数据的 scan   性能提高了 2.7 倍，并改进了当前最先进的 scan   加速器技术（§7）

![image-20230209214931927]( col_sketch_2.png)

# 2 Column Sketches Overview

> 整体思路很好理解，建立一个有损的压缩列进行对比，虽然比较的次数不变甚至可能更多？但是每次比较的字节数变少了，难道说可以用一些 SIMD 指令或者 cpi 更小的指令来进行增加效率？

我们从一个说明性的例子开始来描述主要思想和存储方案。 为了便于演示，我们在示例中使用了简单的有损压缩函数和 scan   算法。 然后，本文的其余部分以此处涵盖的逻辑概念为基础，并展示 Column Sketches 如何使用这些概念来提供强大、高效的性能。

**Supported Base Data Format **对基础数据的唯一要求是给定位置 i 和基础属性 B，它能够为该位置生成值 B[i]。 Column Sketches 适用于行、列组或列数据布局，本文的主体重点介绍列数据布局上的 Column Sketches。。 正如最先进的 AP 系统中常见的那样，假设表的所有基列都在位置上对齐，因此位置用于标识跨列的同一元组的值。 对于数字数据类型和字典编码的字符串数据，基础数据是一个固定宽度值的数组，位置 i 的值在数组中的索引 i 处。 对于未编码的可变长度数据（例如字符串），存在一个间接级别，偏移量数组指向包含值的 blob 数据结构。

**Column Sketch Format ** Column Sketch 由两个结构组成。 Column Sketch 中的第一个结构是 compression map，一个用 S (x) 表示的函数。 第二个结构是 sketched column。 compression map 使用函数 S 将基础数据中的值映射到 sketched column 中的指定代码。 术语 Column Sketch 指的是 compression map 和 sketched column. 的联合配对，图 2 显示了一个示例。

![image-20230209215342847]( col_sketch_overview.png)

> 图示很清楚表达了 column sketch 的技术实现

(1) Compression Map 压缩图 S 以两种格式之一存储。 如果 S 是保序的，那么我们将生成的 sketched column 称为 order-preserving，并且压缩图存储为排序值的数组。 数组中位置 i 的值给出代码 i 中包含的最后一个元素。 例如，如果位置 i 1 的值为 1000，位置 i 的值为 2400，则代码 i 表示介于 1001 和 2400 之间的值。除了索引 i 处的值外，还有一个位用于表示代码是否为 “独特的”。Unique codes 在第 3 节中讨论。

对于非保序的Column Sketches，函数S由一个包含唯一码的哈希表和一个哈希函数组成。 在这种格式中，频繁值被赋予唯一代码并存储在哈希表中。 不频繁值不存储它们的代码，而是计算为（单独的）哈希函数的输出。

(2) Sketch Column。 Sketch Column B<sub>s</sub> 是一个 fixed-width 的 dense array，位置 i 存储函数 S 的输出，该函数 S 应用于基础数据位置 i 的值。 为了区分 base data 和 sketch column 中的值，我们将基础数据中的值称为简单值，将sketch column中的值称为code value。

示例： Building & Querying a Column Sketch。 考虑图 2 中所示的示例，其中我们使用由中间数组定义的函数 S 将 8 位无符号整数 I8 映射到 2 位无符号整数 I2。 S 是保序的，因此它具有以下属性：

```
1. for x, y in column b, S(x) != S(y) -> x != y
2. for x, y in column b, S(x) < S(y) -> x < y
```

此外，S 生成一个 固定宽度（两位）的输出，并将基础数据中相同数量的值分配给每个代码。

我们使用 S 从基础数据构建一个较小的草图列。 对于基本属性 B 中的每个位置 i，我们将草图列中的位置 i 设置为 S (B[i])。 草图列的大小是原始列的 1/4，因此 scan   它需要较少的 data movement。 例如，考虑使用谓词 WHERE B < x 的查询求值。 因为 S 是保序的，所以 Column Sketch 可以将这个谓词翻译成 `(Bs <S(x)) OR (Bs =S(x)AND B < x)`。

为了评估谓词，Column Sketch 首先计算 S (x )。 然后，它 scan   绘制的列 Bs 并检查 Bs < S (x ) 和 Bs = S (x )。 对于小于 S (x) 的值，它们的基值符合条件。 对于大于 S(x) 的值，它们在基础数据中的值不合格。 对于等于 S (x) 的值，它们的基值可能合格也可能不合格，因此我们使用基础数据评估 B < x。 算法 1 描述了这个过程。

图 2 显示了一个示例。 草图列中的位置 1 和 4 在没有看到基础数据的情况下合格。 基础数据中需要检查位置 5 和 6，这两个中只有位置 6 符合条件。 在示例中，Column Sketch 需要两次访问基础数据，同时检查 8 个值。 这是由压缩代码中的少量比特解释的。 通常，Column Sketch 中的每个代码具有相对相等的值数量，并且 Column Sketch 每当看到映射的谓词值 S (x) 时都需要检查基础数据。 因此，我们预计每 2#bits 值需要访问一次基础数据。

![image-20230209220857541]( col_sketch_algo.png)

**Byte Alignment. ** Sketch Column 适用于任何code大小。 然而，我们发现在现代硬件上，使用非字节对齐代码会导致大约 30% 的性能损失。 因此，我们特别关注 8 位 Column Sketches 和 16 位 Column Sketches。 

# 3 Constructing Compression Maps

我们现在展示如何为 Column Sketches 构建 Compression Map。 根据定义，此映射是从 base data 到 sketch column 的函数。 为了复习压缩图，我们在第 3.1 节讨论了它们的目标，在第 3.2 节中保证了它们的实用性，并在第 3.3 和 3.4 节中讨论了如何为数值和分类属性构建它们。

## 3.1 Compression Map Objectives

> 说明了 compression map 设定的一些原则

压缩图的目标是限制我们需要访问基础数据的次数并有效地支持数据修改。 为此，压缩图：

(1) 为常见值分配自己唯一的代码。 当检查 B < x 等查询的 endpoints  时，Column Sketch  scan   需要检查代码 S (x) 的基础数据。 如果 x 是一个有自己编码的值（即 S <sup>-1</sup> (S(x)) = {x}），那么我们不需要检查基础数据，只需通过 Column Sketch 就可以直接回答查询。 此属性适用于范围谓词和相等谓词。

为了实现强大的 scan   性能，我们识别频繁值并为它们提供自己的唯一 code。 举一个简单的例子来说明为什么这对稳健的性能至关重要，如果我们有一个值占元组的 10%，并且它有一个非唯一代码，那么基于这个值的分配代码的谓词需要访问基础数据一个重要的 次数。 因为访问高速缓存行中的任何数据项都会将整个高速缓存行带到处理器，所以访问 10% 的元组可能会使性能类似于传统 scan   。 因此，我们确定了频繁值，以便我们可以限制我们为任何谓词接触的基础数据量。

(2) Assign non-unique codes similar numbers of values。 这样做的原因类似于为什么频繁值需要唯一代码的原因。 我们为每个非唯一代码分配了相对均匀且较小的数据集部分，因此我们只需要少量的基础数据访问即可进行任何 scan   。

(3) 必要时保持顺序。 某些属性会看到范围谓词，而其他属性则不会。 对于看到范围谓词的属性，压缩映射应该保持顺序，以便可以使用 Column Sketch 评估范围查询。

(4) Handle unseen values in the domain without re-encoding。 重新编码应该是一种罕见的按需操作。 由于有损的性质，有损压缩意味着允许新值与已经出现的值无法区分。 因此，只要我们巧妙地定义我们的编码，新值就不需要重新编码 Column Sketch。 对于不需要重新编码的有序柱状图，不能有连续的唯一代码。 例如，如果 S 将唯一代码 i 分配给“gale”，将 i + 1 分配给“gate”，则输入字符串（如“game”）没有代码值。 将“gate”的代码更改为非唯一的可以解决这个问题。 对于无序的 Column Sketches，只要存在至少一个非唯一代码，每个看不见的值都有一个可能的值。

(5) Optional：利用频繁查询的值。 利用频繁查询的值可以提供额外的性能优势； 然而，与频繁的数据值不同，识别频繁的查询值会降低查询性能的稳健性。 我们在本文的主要部分着重于描述如何为任何查询实现高效和稳健的性能，并在附录 F 中包含有关利用频繁查询值的详细信息。

## 3.2 Bounding Base Data Accesses

以下两个定理适用于我们如何限制分配给非唯一代码的值的数量。

定理一：对于有限定义域 X 中的 x<sub>1</sub> < x<sub>2</sub> <...<x<sub>m</sub> ，值域 Y 中的  y<sub>1</sub> < y<sub>2</sub> <...<y<sub>m</sub> ，要保证函数对应之后是有序的，也就是类似上面的图二中的（保序性）

这个保序函数的定理意味着结果也适用于非保序函数。

定理二：要保证每个  y<sub>i</sub> 的 frequency 都大于等于 `2/n`，（其实就是限制 y 的个数）

定理和推论证明我们可以创建映射来限制分配给任何非唯一代码的基础数据中的值的数量。 这直接意味着我们可以限制我们需要访问基础数据的次数。 定理 1 和推论 2 的证明分别在附录 A 和 B 中给出，两个证明都给出了显式构造 S 的算法。每个单独给出证明，因为用于创建无序压缩映射的算法给出 每个非唯一代码中值的数量差异较小的映射。

## 3.3 Numerical Compression Maps

**Lossless Numerical Compression.** 对于数字数据类型，frame-of-reference (FOR)、prefix supression 和 null supression 等无损压缩技术通过将值存储为某个偏移量的相对值来工作。 这三种技术都支持压缩形式的操作； 特别是，它们可以在不解压缩的情况下执行相**等谓词、范围谓词和聚合运算符**。 然而，为了有效地支持聚合，这些技术中的每一种都保留了差异； 即，给定基值 a 和 b，它们的编码值 e<sub>a</sub> 和 e<sub>b</sub> 满足 e<sub>a</sub> -  e<sub>b</sub>  = a - b。 这限制了它们改变高位熵的能力，并且只有当列中的每个值在这些高位上全为 0 或全为 1 时，这些位才能被截断。

**Constructing Numerical Compression Maps** 与无损技术相比，有损压缩仅专注于最大化草图中位的效用。 在保留顺序的情况下执行此操作的最简单方法是构建一个近似于输入数据的 CDF 的等深度直方图，然后根据每个直方图桶的 endpoints  创建代码。 当在我们的数值域中给定一个值时，映射的输出就是一个值所属的直方图桶。 我们通过从基列中统一采样值、对这些值进行排序，然后根据该排序列表生成每个桶的 endpoints  来创建近似等深度直方图。
因为直方图桶是连续的，存储每个桶的 endpoints   i 就足以知道直方图桶覆盖的范围。 图 3a 和 3b 显示了使用两个不同数据集的直方图进行映射的示例。 在这两个图中，我们使用 200,000 个样本来创建 256 个 endpoints  。 均匀分布从 0 到 10,000,000，正态分布数据的均值为 0，方差为 1000。均匀分布的代码在整个过程中均匀分布，正态分布的代码越靠近分布的 endpoints  ，越接近 一起走向中间。 直方图捕获两个函数的分布，并在代码之间均匀分布基础数据中的值。

> 通过等高直方图来选择这些数字，形成近似直方图

**Handling Frequent Values** 

> Q: 这里有点复杂，没完全看明白，需要下来仔细看下理一下流程，给出原文，下次再仔细看
>
> ![image-20230209234105694]( col_sketch_handing_freq1.png)
>
> ![image-20230209234134888]( col_sketch_handling_freq2.png)

我们将频繁值定义为出现在超过 z1 个基础数据值中的值。 为了处理这些频繁值，我们首先执行与之前相同的过程并创建一个排序的采样值列表。 如果一个值表示大小为 n 的样本的 z1 个以上，则排序列表 at(n,2n,..., (z-1)n) 中的值之一必须是该值。 因此，对于这些 z 值中的每一个，我们可以搜索它的第一次和最后一次出现以检查它是否代表样本的 z1 以上。 如果是这样，请标记该值在列表中的中间位置，并为该值赋予唯一代码 c ⇒ 中点（四舍五入为最接近的整数），其中 c 是 sketched column 中的代码数。 在 z > c 并且两个值将被赋予相同的唯一代码 c 的情况下，更频繁的值将被赋予该唯一代码。 在本文中，我们使用 z = c。 虽然较大的 z 值可以创建更快的平均查询时间，但我们选择 z = c 以便使代码唯一不会增加非唯一代码中值的比例。

在找到值得唯一代码的值并为它们提供关联的代码值后，我们在每个唯一代码之间平均划分排序列表，并相应地分配剩余的代码值。 与单次遍历样本相比，唯一代码的识别在最坏的情况下，非唯一代码的划分是一个恒定时间的操作。
为了使更新不能强制重新编码，我们不允许唯一代码占据后续位置。 如果在先前的过程中，值 i 和 i+1 将分别被赋予唯一代码 i 和 i + 1，则只有更频繁的值被赋予唯一代码。 对于要分配给后续代码的值，频率较低的代码最多只能包含 c2 个采样值，因此我们先前针对没有具有太多值的非唯一代码的稳健性结果仍然成立。 此外，我们不允许压缩图中的 first 和 last 代码是唯一的。

**Estimating the Base Data Distribution.** 

> PS：这里也没太仔细深究其中数据分布的细节，下次需要再仔细看，给出原文
>
> ![image-20230209234236843]( col_sketch_distribution.png)

为了使压缩图在每个代码中具有大致相等数量的值，从经验 CDF 创建的采样直方图需要密切遵循基础数据的分布。 Dvoretzky-Kiefer-Wolfowitz 不等式提供了 n 个样本的经验 CDF Fn 向真实 CDF F 收敛的界限，我们可以将真实分布 F 视为未知量，将列视为独立同分布。 F 的样本，或者我们可以将该列视为离散分布，其 CDF 恰好等于基础数据的 CDF。 在这两种情况下，从基础数据中采样 n 次可以得到我们采样数据的经验 CDF Fn 与真实 CDF F1 的距离所需的结果。 我们在第 7 节中证明，对于一个字节的 Column Sketch，任何少于 4 个基础数据的列都比普通 scan   提供 2 x  性能优势。 由于 Column Sketch 映射从不分配单个非唯一代码。 我们的目标是 = 256 。 对于图 3 中的 200,000 个样本，出现此数量错误的可能性小于 10 5。 样本数 n 和期望值都是可调的。

## 3.4 Categorical Compression Maps

**Categorical Data and Dictionary Encoding.** 与数字分布不同，分类分布通常具有占据数据集重要部分的值。 此外，某些分类分布不需要顺序。

传统上，分类分布已经使用（可选的保序）固定宽度字典编码进行编码。 字典编码通过为每个唯一值赋予其自己的数字代码来工作。 一个简单的例子是美国的州。

虽然这可能被声明为 varchar 列，但只有 50 个不同的值，因此每个状态都可以用 0 到 49 之间的数字表示。由于每个不同的值都需要一个不同的代码，因此存储字典所需的位数 -编码值为 [log2 n]，其中 n 是唯一值的数量。

**Lossy Dictionaries.** 分类分布的压缩图看起来类似于字典编码，除了稀有代码已经相互折叠，使代码值的数量更小。 这种折叠的主要好处是 scan   绘制的列读取更少的内存。 然而，还有一个处理上的好处，因为我们可以选择非单射编码中代码值的数量，以便代码具有固定的字节长度。 例如，如果我们查看具有 1200 个唯一值的数据集，那么字典编码的列每个值需要 11 位。 如果这些代码一个接一个地密集打包，它们将不会从字节边界开始，CPU 将需要解包代码以将它们对齐到字节边界。 如果它们没有密集打包，那么代码将被填充到 16 位，这反过来又会带来更高的 data movement 成本。 使用 Column Sketches，有损编码方案可以选择位数为 8 的倍数，从而节省 data movement 而无需进行代码解包。

图 4 中显示的示例比较了美国各州的保序字典和保序有损字典。 仅显示唯一代码，在隐含间隙中显示非唯一代码。 尽管这是一个简化的示例，但它显示了我们希望为有损字典保留的各种属性。 最频繁的值，在这种情况下是人口最多的州，被赋予唯一的代码，而较少的值共享代码。 加利福尼亚州的唯一代码为 1，而怀俄明州与威斯康星州、西弗吉尼亚州和其他几个州共享代码 14。 这 7 个唯一代码覆盖了美国近 50% 的人口。另外 50% 的人口分布在 8 个非唯一代码中，每个非唯一代码预计有 6.25% 的数据。 然而，这是由于非唯一代码的数量很少。 例如，如果我们将其更改为美国的城市，其中大约有 19,000 个，并且有 128 个唯一代码和 128 个非唯一代码，那么每个非唯一代码将只有 0.6% 的数据。

![image-20230209225202248]( col_sketch_lossy.png)

**Unordered Categorical Data.** 我们首先讨论为不需要数据排序的分类分布分配代码。 不需要有序的代码值，我们可以自由地将任何值分配给任何代码值。 这种选择的自由使得可能的压缩图空间非常大，但也产生了相当好的直观解决方案。 我们有三个主要的设计决策：

1.  应该给多少个值赋予唯一码？
2.  我们给哪些值赋予独特的代码？
3.  我们如何在非唯一代码之间分配值？

(1) Assigning Unique Codes.。 分配唯一代码的最简单方法是为最频繁出现的值赋予唯一代码。 这是稳健的，因为它限制了我们访问任何谓词的基础数据的次数。 附录 F 中介绍了分析查询历史以分配唯一代码值的更积极（但可能不太健壮）的方法。

(2) Number of Unique Codes.。 选择要创建多少个唯一代码是一个可调的设计决策，具体取决于手头应用程序的重新要求。 我们在这里描述了做出此决定的两种方法。 一种方法是为样本中出现频率超过某个频率 z 的每个值赋予一个唯一的代码值，让剩余的代码分布在频率小于指定截止值的所有值中。 此参数 z 具有与有序情况相同的权衡，根据工作负载和应用程序要求对其进行调整是未来工作的一部分。 在本文中，z 设置为 256，原因与有序情况类似。 分配唯一代码的第二种方法是为唯一代码的数量设置一个常量值。 第二种方法对某些值特别有效。 例如，如果恰好一半分配的代码是唯一代码，那么我们可以使用代码值的第一位或最后一位来描述唯一代码和非唯一代码。

(3) Assigning Values to Non-Unique Codes。 摄取数据的最快方法是使用哈希函数在非唯一代码之间相对均匀地分配值。 如果有 c 个代码和 u 个唯一代码，我们将唯一代码分配给代码 0、1、.... , u-1. 当对传入值进行编码时，我们首先检查包含频繁值的哈希表以查看传入值是否被唯一编码。 如果该值是唯一编码的，则其代码将写入 Sketch Column。 如果不是，则将该值编码为“u +[h(x)%(c-u)]”。

> 这里是分配 unique code 和 non-unique code 的方式，这样可以将非唯一编码写入到唯一编码之后的位置中去

Analysis of Design Choices. 。 到目前为止，**最重要的性能特征是确保最频繁的值被赋予唯一代码**。 图 5 和图 6 显示了赋予任何非唯一代码的最大数据项数以及所有非唯一代码的平均值。 在这两个图中，我们有 100,000 个元组，给定 10,000 个唯一值，我们看到每个值遵循 Zipfian 分布的频率。 稀有值通过散列分布在非唯一代码中。 在第一个图中，我们将偏斜参数保持为 1 并改变唯一代码的数量。 在第二张图中，我们使用了 128 个唯一代码并更改了数据集的倾斜度。 如图 5 所示，选择适量的唯一代码可确保每个非唯一代码在基础数据中具有合理数量的值。 图 6 显示，对于同时具有高偏斜和低偏斜的数据集，每个非唯一代码中的元组数量只占数据的一小部分。 有序分类数据。 有序分类数据共享无序分类数据和数值数据的属性。 与数字数据一样，我们希望看到查询询问有关域中某些元素范围的问题。 与无序分类数据一样，我们希望看到基于相等比较的查询。 跨代码均匀分布域中的值可实现两者所需的属性。 因此，为识别数值数据中的频繁值而给出的算法也适用于有序的分类数据。

# 4 Predicate Evaluation Over Column Sketches

对于 Column Sketch 评估的任何谓词，我们都有可以被视为查询 endpoints  的 code。 例如，第 2 节中作为示例给出的比较 B < x 具有 endpoints   S(x)。 对于具有小于和大于子句的范围谓词，例如 x1 < B < x2，谓词有两个 endpoints  ：S(x1) 和 S(x2)。 虽然从技术上讲，相等谓词没有 endpoints  ，因为它不是范围，但为了符号的一致性，我们可以将 S(x) 视为谓词 B = x 的 endpoints  。

**SIMD Instructions.**。 SIMD 指令提供了一种通过一次对多个数据元素执行一条指令来实现数据级并行性的方法。 这些指令看起来像传统的 CPU 指令，例如加法或乘法，但有两个额外的参数。 第一个是所讨论的 SIMD 寄存器的大小，可以是 64、128、256 或 512 位。 第二个参数是正在操作的数据元素的大小，可以是 8、16、32 或 64。例如，指令 `_mm256_add_epi8 (_- _m256i a, __m256i b) `需要两个数组，每个数组有 32 个元素 8 位，并通过将输入中的相应位置一次性相加产生一个包含 32 个 8 位元素的数组。 

**Scan API**。 Column Sketch scan 采用 Column Sketch、predicate operation 及其的值。 它可以输出匹配位置的 bit-vector 或匹配 position-list ，默认输出是 bit-vector 。 通常，对于非常低的选择性，应该使用 position-list ，而对于更高的选择性，应该使用 bit-vector 。 这是因为在高选择性下， position-list 格式需要大量的内存移动。

 **Scan Procedure**。 算法 2 描述了针对一字节 sketched column 的基于 SIMD 的 sketched column  scan   。 它使用 Intel 的 AVX 指令集并产生 bit-vector 输出。 出于空间原因，我们省略了几个变量的设置，并使用逻辑描述而不是物理指令来进行更长的操作。

嵌套循环的内部负责逻辑计算哪些位置匹配，哪些位置可能匹配。 在第一行中，我们在执行我们需要的两个逻辑比较之前加载了我们需要的 16 个代码。 对于小于的情况，我们唯一的 endpoints  是 S (x)，我们在第 10 行使用相等谓词检查这个值。对于匹配这个谓词的每个位置，我们需要转到基础数据。

在这些比较之后，我们将绝对合格的位置转换为 bit-vector 并立即存储。 对于可能的匹配位置，我们执行条件存储。 为了简洁起见，我们的代码中省略了条件存储，首先检查其结果 bit-vector 是否全为零。 如果不是，它将条件 bit-vector 转换为 position-list 并将结果存储在堆栈上的一个小缓冲区中。 在创建 Column Sketch 时，可能匹配值的结果 bit-vector 通常全为零，因此没有代码包含太多值，因此很少执行将 bit-vector 转换为 position-list 并存储位置的代码 . 作为一个小细节，我们发现将临时结果存储在 stack 中很重要。 将这些临时结果存储在 heap 上会降低 15% 的性能。

Column Sketch  scan   被分成较小段的嵌套循环，因此该算法可以使用 base data 修补结果 bit-vector ，同时结果 bit-vector 保留在 CPU 缓存的高级中。 如果我们最后检查所有可能匹配的位置，我们会看到大约 5% 的轻微性能下降。

**Unique Endpoints**。 独特的 endpoints  使 scan   的计算效率更高。 如果代码 S(x) 是唯一的，则不需要跟踪位置，也不需要条件存储指令。 此外，该算法只需要进行一次小于比较。 比较之后，它立即写出 bit-vector 。 更一般地说，给定一个唯一代码，对 Column Sketch 的 scan   完全回答了查询而不参考基础数据，因此看起来与正常 scan  完全一样，但是 data movement 较少。

**Equality and Between Predicates**。 相等谓词和谓词之间的处理与算法2类似。对于相等谓词，主要区别在于，根据代码是否唯一，初始比较只需要存储

![image-20230209231840553]( col_sketch_predicate_eval.png)

> 算法主要利用了 SIMD 指令加速，
>
> 循环所有数据，每次循环处理一次 SIMD 指令能够处理的最多位数
>
> 将所有数据分成两部分，
>
> * 第一部分是肯定全部 ok 的，也就是根据 unique code 或者条件满足的
> * 第二部分就是可能不满足，出现假阳性的时候把可能得位置存到 tmp_result 中
>
> 最后统一检查原始数据是否满足条件

# 5 Performance Modeling

Column Sketch 的性能主要取决于 memory 中 data movement 的 cost，这里发现内存带宽都是打满的。

# 6 System Integration and Memory Overhead

## System Integration

Column Sketches 的许多组件已经部分或完全存在于成熟的数据库系统中。 **创建压缩图需要采样和直方图**，几乎每个主要系统都支持它们。 第 4 节中给出的 SIMD 扫描类似于分析数据库中已经存在的优化扫描，基础数据上的区域映射可以过滤出 Column Sketch 的相应位置对齐部分。 在 Column Sketch 中添加数据和更新数据类似于对字典编码的属性进行数据修改。 在第 7 节中，我们展示了 Column Sketch 扫描总是比传统扫描更快。 因此，优化器可以在传统索引和 Column Sketch 之间使用相同的基于选择性的访问路径选择，具有较低的交叉点。 同样，Column Sketches 可以自然地处理任何支持比较的有序数据类型。 这与早期剪枝技术等相关技术形成对比，这些技术需要修改浮点数等各种类型的默认编码，使其具有二进制可比性。 最后，Column Sketches 不改变基础数据布局，因此除了 select 之外的所有其他运算符都可以保持不变。

## Memory overhead

令  b<sub>s</sub>  为  column sketch  中每个元素的位数。 然后我们需要  b<sub>s</sub>   x  n 位的空间用于 sketch column 。 如果我们让  b<sub>b</sub>  是基本数据元素所需的位数，那么每个字典条目都需要  b<sub>b</sub>  + 1 位空间，其中额外的位来自标记该代码的值是否唯一。 完整字典的大小是 ( b<sub>b</sub>  + 1)  x  2<sup>b</sup> 位。 值得注意的是，b 通常很小（我们在本文的所有点都使用 b = 8 来创建字节对齐），因此字典通常也很小。 此外，字典的大小与列的大小 n 无关，因此随着 n 的增长，  column sketch  的开销接近  b<sub>s</sub>   x  n 位。 此外，我们注意到 Column Sketch 最适合在允许高效位置访问的基列上使用压缩技术。 当数据在内存中时，大多数分析系统通常都是这种情况，因为数据通常使用固定宽度编码进行压缩。

# 7 Expermental Analysis

和下面三种方法对比：

* BitWeaving/V
* Column Imprints
*  a B-tree index

实验都是在内存中进行，不包含磁盘IO。

16MB L3 cache + 64 physical thread + 1T memory，取100次实验的平均值代表性能

* 7.1 Uniform Numerical Data
* 7.2 Skewed Numerical Data
* 7.3 Categorical Data
* 7.4 Load Performance

给几张实验结果图，可以看到 column sketch 相较其他的 index 方法全面碾压。

![image-20230209234901743]( col_sketch_expe.png)

![image-20230209235022689]( col_sketch_expe2.png)

# 8 Related Work

**Compression and Optimized Scans**。 2000 年代中期，MonetDB 和 C-Store 开始将压缩和执行紧密集成到面向列的数据库中的扫描中。 从那时起，已经完成了将多种类型的压缩集成到扫描中的工作，特别是字典压缩、增量编码、参考帧编码和游程编码。 如今，混合压缩和执行已成为标准，并且在大多数商业 DBMS 中都可以看到。 最近，IBM 创建了频率压缩，利用数据重新排序来提高扫描性能。

这些技术中的每一种都是无损的，旨在用于基础数据。 因此，这些技术可以通过使用有损而不是无损压缩来实现更高的压缩率，从而减少扫描期间的内存和磁盘带宽。 过去曾假设有损压缩用于谓词评估的潜力，但没有提出解决方案 。

**Early Pruning Extensions**。 Li、Chasseur 和 Patel 研究了用于位分片索引的无损可变长度编码方案，旨在使查询处理中的高阶位信息丰富。 这解决了数据值倾斜的问题，并且还利用了更频繁查询的谓词值。 如果偏斜足够严重，以至于频繁值或频繁查询的值需要少于 8 位，那么生成的位切片索引在查询这些值时会比 Column Sketch 更快。 此外，与传统的位分片索引一样，即使列的代码值小于 8 位，生成的索引也很有用。

然而，没有考虑有损编码方案。 通过保持编码方案无损，填充的可变长度编码方案具有更大的内存占用和更昂贵的写入时间。 同样，生成的填充可变长度编码方案的生成成本很高，需要花费大量运行时间来生成 24 位或更小代码大小的编码方案。 未来工作的一个有趣方向是将中的技术与 Column Sketches 混合，并在 Column Sketch 的草绘列内使用填充位编织列。

**Lightweight Indices**。 轻量级数据跳过技术（例如 Zone Maps 及其等效技术）提供了一种通过为每列保留简单元数据（例如最小值和最大值）来跳过大数据块的方法。 它们包含在许多最近的系统中 ，而如何最好地组织数据和元数据是一个正在进行的研究领域。 在最近的方法中，Column Imprints 脱颖而出，因为它与 Column Sketches 在本质上相似。 Column Imprints 还使用直方图来更好地评估谓词，但一次对一组值而不是一次对单个值这样做。

对于具有聚类属性的数据集，数据跳过技术注意到整组值会将谓词评估为真或假，因此在这些场景中提供了令人难以置信的加速。 对于非集群的数据集，轻量级索引无法一次评估一组数据，因此扫描需要单独检查每个值。 相比之下，Column Sketches 能够处理这些查询，因为它已经在逐个元素的基础上工作。 因此，轻量级索引应与 Column Sketches 结合使用，因为两者更新成本低且针对不同的场景。

**Other Operators over Early Pruning Techniques.**。 Early Pruning Techniques 的使用已推广到谓词评估之外的其他运算符。 这项工作的大部分都可以应用于柱草图。 例如，MAX 运算符可以查看 b 个高阶位并修剪所有小于仅使用这 b 个位看到的最大值的记录，因为它们肯定不是最大值。 这类似于 Column Sketches，其中任何不是 Column Sketch 字节最大值的值显然不是列中的最大值。

**SIMD Scan Optimizations.**。 最近有一股关于如何最好地将 SIMD 集成到列扫描中的研究。 本文中的解包方法基于 Willhalm 等人的工作。 他们使用 SIMD 通道解包代码，每个 SIMD 通道一个代码。 扫描计算性能的改进是对 Column Sketches 的补充。 Column Sketches 被设计为可扫描的密集数组结构，因此评估谓词的改进同样适用于 Column Sketches。

# 9 Conclusion

在本文中，我们展示了传统索引和轻量级数据跳过技术都无法为对非集群数据具有适度选择性的查询提供性能优势。 为了为这一大类查询提供性能改进，我们引入了一种新的索引技术 Column Sketches，无论数据排序、数据分布和查询选择性如何，它都能提供更好的扫描性能。 与扫描加速器的最先进方法相比，Column Sketches 更容易更新，并且在一系列不同数据分布的扫描中性能更高。 Column Sketches 的可能扩展包括等式和范围谓词以外的运算符的使用，例如聚合、集合包含谓词和近似查询处理。
