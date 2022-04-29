---
title: 6.s081-lab pgtbl实验报告
date: 2022-03-21 20:13:49
categories:
- 6.s081
---

最近因为有些事情，好久没更新了，这次抽点时间又把后面的 lab 做一下，来记录下笔记便于之后自己复习

<!--more-->

## Print a page table

This is how I solved it:

```c
void
vmprint(pagetable_t pagetable)
{
  printf("page table %p\n", pagetable);
  kvmprint(pagetable, 2);
  return;
}

void
kvmprint(pagetable_t pagetable, int level)
{
  if (level < 0)
    return;
  
  uint64 MAX_ENTRIES = 512;
  pte_t *pte;
  uint64 pa;
  int loop = 3 - level;

  for (int i = 0; i < MAX_ENTRIES; i++) {
    pte = &pagetable[i];
    if (*pte & PTE_V) {
      pa = PTE2PA(*pte);
      if (pa == 0 || pa >= PHYSTOP) {
        continue;
      }
      for (int i = 0; i < loop - 1; i++)
        printf(".. ");
      printf("..%d: pte %p pa %p\n", i, *pte, pa);
      pagetable_t pgtbl = (pagetable_t)pa;
      kvmprint(pgtbl, level - 1);
    }
  }

}
```

## A kernel page table per process

goal：

* allow the kernel to directly dereference user pointers

> 内核和用户空间保存了不同的页表，内核不包含用户空间的页表，所以当用户空间进行系统调用的时候，如果传入了一个用户空间的指针（例如，write 的 buffer 指针），那么内核必须首先将这个将这个指针翻译成物理地址再进行操作

job：

* 修改内核，让每个进程都有一份对内核页表的拷贝，修改 `struct proc` 让每个进程都有一个内核页表，然后修改 `scheduler`，让内核切换的时候能够修改内核页表，在这一步，每个进程的内页页表应该和全局的内核页表一模一样

> 需要理解的点：
>
> * 跳板页是在用户空间和内核空间中都存在的，进行系统调用的时候从这个地方进入，两者有相同的代码段，这样就可以传递参数到内核空间中，然后在内核栈中进行系统调用的执行，然后再将结果放到跳板页中来返回继续执行了，这样就得到了系统调用的返回值
> * 但是之前系统调用的时候切换了页表，所以在用户空间没有内核的页表，所以内核无法解析用户空间的指针对应的内存位置

Some hints:

* Add a field to `struct proc` for the process's kernel page table.

> 修改 `proc.c` 中的 `struct proc` ，给结构体增加一个新的变量
>
> ```c
> struct proc {
> ...  
> pagetable_t kpagetable;      // Kernel page table
> ...
> }
> ```

* A reasonable way to produce a kernel page table for a new process is to implement a modified version of `kvminit` that makes a new page table instead of modifying `kernel_pagetable`. You'll want to call this function from `allocproc`.

> 在思考，如果需要在切换到内核中的时候能够直接 dereference，那么就是说在 内核态 执行代码的时候直接用刚才保存的这个页表才行，这个页表中应该也要保存用户空间内的地址映射

* Make sure that each process's kernel page table has a mapping for that process's kernel stack. In unmodified xv6, all the kernel stacks are set up in `procinit`. You will need to move some or all of this functionality to `allocproc`.

> `procinit` ，注意在 xv6 中的进程都是复用之前的，申请到的栈空间都直接保存到了内核页表中但是之后，不仅需要保存内核栈的地址映射到 kernel pagetable 中，也需要将其映射到用户空间的内核栈中，所以可以直接推迟每个内核栈的初始化
>
> 是否可以直接在 `allocproc` 的过程中获取到内核栈的物理地址，然后也映射到用户空间的内核页表中呢？
>
> 这个思路看上去不太好，因为内核页表并没有暴露 kernel_pagetable 到外面，所以不是很好在已经初始化好之后再修改，应该每次都重新分配一下内核栈，然后同时映射到内核页表和用户空间的内核页表中去
>
> 突然想到这样效率可能不高，是不是可以把内核栈的物理地址保存到 proc 中，然后每次 alloc 的时候把这个物理地址映射到进程的内核栈中去

* Modify `scheduler()` to load the process's kernel page table into the core's `satp` register (see `kvminithart` for inspiration). Don't forget to call `sfence_vma()` after calling `w_satp()`.

> 在调度器进行调度的时候，如果找到了一个可以运行的进程，那么直接切换到内核进程的页表
>
> ```c
> // 切换内核页表
> w_satp(MAKE_SATP(p->kpagetable));
> sfence_vma();
> ```

* `scheduler()` should use `kernel_pagetable` when no process is running.

> 有一个现成的函数实现，直接在空循环的时候调用即可，
>
> ```c 
>   kvminithart();
> ```

* Free a process's kernel page table in `freeproc`.
* You'll need a way to free a page table without also freeing the leaf physical memory pages.

> 注意，内核页表本身并没有申请任何内存，只是保存了映射，所以直接 freewalk 的实现其实就OK了，这个理解并不对，进行 page map 的时候会递归生成相应的页面，所以最后也得全部都释放掉，不然找不到内存了，这里只需要释放掉对应的页表的空间就行了，不需要释放掉实际映射的物理页面

上面是我自己在做的时候的一些想法和笔记，但是在实际实现的时候需要对实际的过程理解清楚即可，下面是实现的几个重要的点：

1. 需要给 process 中的 kernel pagetable 进行映射，映射 kernel pagetable 的地址空间，但是注意在释放的时候不需要释放掉实际的物理页面，因为所有进程都使用了这些物理页面，只需要释放掉每个进程对应的页表即可

```c
static struct proc*
allocproc(void)
{
...
  // user kernel pagetable.
  p->k_pagetable = proc_k_pagetable(p);
  if (p->k_pagetable == 0)
  {
    freeproc(p);
    release(&p->lock);
    return 0;
  }
  char *pa = kalloc();
  if(pa == 0)
    panic("kalloc");
  uint64 va = KSTACK((int) (p - proc));
  // 将 kernel stack 映射到内核页表中，不要忘记这一条
  ukvmmap(p->k_pagetable, va, (uint64)pa, PGSIZE, PTE_R | PTE_W);
  p->kstack = va;

...
  return p;
}
```





# Simplify `copyin/copyinstr`

Goal:

* 内核的 `copyin` 方法从用户的指针读取内存，这个函数将翻译成内核能够直接读取的物理地址。这个函数是通过 `walking` 每个进程的页表来实现的，现在需要给每个进程的内核页表添加上 `user mappings`，来让`copyin` （`copyinstr`）可以直接解引用用户的指针

job：

* 替换 `kernel/vm.c` 里面的 `copyin` 函数，让他调用 `copyin_new` ，对于 `copyinstr` 和 `copyinstr_new` 来做相同的事情，给内核页表来添加用户映射

这个模式如果要行得通，需要用户的虚拟地址不要和内核的虚拟地址发现重叠。xv6 的用户进程空间的虚拟地址从 0 开始，内核的虚拟地址从一个更高的地址开始。然而这个模式需要限制内核的虚拟地址和用户的虚拟地址的范围，当内核启动之后，将会从 `0xC0000000` 地址 PLIC 开始执行，这个地址保存在 `PLIC` 寄存器中，需要阻止 xv6 的用户地址空间不要超过 `PLIC` 的地址

Hints:

* Replace `copyin()` with a call to `copyin_new` first, and make it work, before moving on to `copyinstr`.
* At each point where the kernel changes a process's user mappings, change the process's kernel page table in the same way. Such points include `fork()`, `exec()`, and `sbrk()`.
* Don't forget that to include the first process's user page table in its kernel page table in `userinit`.
* What permissions do the PTEs for user addresses need in a process's kernel page table? (A page with `PTE_U` set cannot be accessed in kernel mode.)
* Don't forget about the above-mentioned PLIC limit.

注意，这里其实就是将用户页表空间的数据映射到内核页表中去，但是需要注意到此时需要保证用户地址空间和内核地址空间不重叠，此时用户地址空间最高不能超过 PLIC 的地址，然后在每次进程地址空间变化的时候将用户空间的页面映射到内核页表即可

```c
void map_user_to_kerneladdress(pagetable_t pagetable, pagetable_t k_pagetable, uint64 oldsz, uint64 newsz)
{
  pte_t *pte_from, *pte_to;
  uint64 a, pa;
  uint flags;

  if (newsz < oldsz)
    return;
  
  oldsz = PGROUNDUP(oldsz);
  for (a = oldsz; a < newsz; a += PGSIZE)
  {
    if ((pte_from = walk(pagetable, a, 0)) == 0)
      panic("map_user_to_kerneladdress");
    if ((pte_to = walk(k_pagetable, a, 1)) == 0)
      panic("map_user_to_kerneladdress");
    pa = PTE2PA(*pte_from);
    flags = (PTE_FLAGS(*pte_from) & (~PTE_U)); // 注意对 PTE_U 位置的清零
    *pte_to = PA2PTE(pa) | flags;
  }
}
```

