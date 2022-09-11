---
title: 6.s081-lab-syscall-实验报告
date: 2022-01-09 15:03:11
categories:
- 6.s081
---

> 终于快回家了，快一年没回过家了，真想回去啊

# Lab- SystemCall

这个实验的内容是给 xv6 增加一些新的系统调用，能够对系统调用的工作原理有更深的理解。

## Debug

启动两个终端，第一个使用 `make qemu-gdb`, 在 makefile 中添加

```sh
gdb:
    riscv64-unknown-elf-gdb kernel/kernel
```

这行命令帮助我们加载 kernel 文件到 gdb 中。然后 macos 上对于 gdbinit 文件会有限制，在 `~/.gdbinit` 中添加一行 `add-auto-load-safe-path <path>/.gdbinit` 即可, 这里的 path 替换为自己的工程文件夹。

如果我们需要加载某个用户态程序，直接 `file user/_sleep` 先 load symbol 到 gdb 中，然后 `break ...`, `continue` 即可。

一个很有用的 debug 命令, `layout` 可以在 gdb 源码层面来单步调试, 非常的舒服。

## trap in xv6

每个 RISC-V 都有一些专用的寄存器来告诉 CPU 如何处理一个 trap，下面是在 trap 中使用到的最重要寄存器

* `stvec` kernel 把 trap handler 的位置写到这个寄存器，RISC-V 在处理 trap 的时候会跳转到这个寄存器的地址中来
* `sepc` 当从 user space trap 到 kernel space 的时候，RISC-V 将会把 pc 保存到 `sepc` 中来（因为之后 pc 的值会被 `stvec` 的值覆盖），`sret` 指令会把 `sepc` 的值重新 copy 到 pc 中来。
* `scause` RISC-V 在 trap 中写入一个值，代表当前 trap 的原因
* `sscratch` kernel 在 trap handler 最开始的地方写入一个值
* `sstatus` ：在`sstatus`中的`SIE` bit会控制设备的中断是否开启，如果 kernel 清除了 `SIE`，那么RISC-V 将会 defer 设备的中断直到重新设置 `SIE` bit。`SPP` bit 表示 trap 是从 user mode 还是 supervisor mode 中来的。

注意，这些寄存器都不能在 user mode 下访问。

下面是一个处理 trap 的流程：

1. If the trap is a device interrupt, and the sstatus SIE bit is clear, don’t do any of the following.
2. Disable interrupts by clearing SIE.
3. Copy the pc to sepc.
4. Save the current mode (user or supervisor) in the SPP bit in sstatus.
5. Set scause to reflect the trap’s cause.
6. Set the mode to supervisor.
7. Copy stvec to the pc.
8. Start executing at the new pc.

注意 CPU 并没有切换内核页表，也没有切换到内核中的栈，也没有保存除了 pc 以外的寄存器。

# tracing syscall

这个实验比较简单，主要在于了解在哪些地方涉及到系统调用的修改，这里可以分为 user space 和 kernel space 两个部分的修改，

## user space

在用户空间实验提供了一个 `trace.c` 来执行 trace 调用调用，但是直接在 makefile 中添加之后，还需要在用户空间使用的 `user/user.h` 和 `user/usys.pl` 这两个文件来增加 `sys_trace` 的系统调用，

`user/user.h`  添加是为了添加 syscall 在用户空间的函数原型，而  `user/usys.pl` 是修改 perl 脚本，自动生成一个带有 `ecall` 的系统调用函数，可以直接从 user space 跳到 kernel space，注意这里系统调用的实现并没有切换页表，xv6 在内核的地址空间和用户的地址空间都有一个相同地址的 `trampline.S` 的跳板页，可以在切换模式后仍然正常执行。

## kernel space

在 内核空间中  `kernel/syscall.h` 中添加 `sys_trace` 的函数原型。

由于支持 `fork()` 之后仍然是能够 trace 系统调用，所以需要在 进程的状态中维护一个 `trace_mask` 变量，在 `fork` 生成新的进程之后仍然可以正常执行。

最终，在 `syscall() ` 查表执行对应 trap handler 的时候，根据当前进程是否有 `track_mask` 来决定是否打印出来一些信息即可：

```c
static char* syscall_str [] = {
  "",
  "fork",
  "exit",
  "wait",
  "pipe",
  "read",
  "kill",
  "exec",
  "fstat",
  "chdir",
  "dup",
  "getpid",
  "sbrk",
  "sleep",
  "uptime",
  "open",
  "write",
  "mknod",
  "unlink",
  "link",
  "mkdir",
  "close",
  "trace",
};

void
syscall(void)
{
  int num;
  struct proc *p = myproc();

  num = p->trapframe->a7;
  if (num > 0 && num < NELEM(syscalls) && syscalls[num]) {
    int res = syscalls[num]();
    p->trapframe->a0 = res;
    int trace_mask = p->trace_mask;
    if ((1 << num) & trace_mask) {
      printf("%d: syscall %s -> %d\n", p->pid, syscall_str[num], res);
    }
  }
  else {
    printf("%d %s: unknown sys call %d\n",
            p->pid, p->name, num);
    p->trapframe->a0 = -1;
  }
}

```

# Sysinfo

这个实验也比较简单，需要我们打印出系统当前的状态，需要看一下内存管理和进程模块，不过都比较简单，比较有价值的是如何从 `kernel space` 拷贝到 `user space` 的过程，这里使用到了 `copyout` 这个函数来做，下面是实现的代码

```c
// sysinfo.c
int
sys_sysinfo(void) {
  uint64 addr;
  if (argaddr(0, &addr) < 0)
    return -1;

  struct sysinfo info;
  info.freemem = freemem();
  info.nproc = freeprocs();
  struct proc* p = myproc();
  if (copyout(p->pagetable, addr, (char*)&info, sizeof(info)) < 0)
      return -1;
  
  return 0;
}

// kalloc.c
int freemem()
{
  struct run* r;
  
  acquire(&kmem.lock);
  r = kmem.freelist;
  int total = 0;
  while (r) {
    total += PGSIZE;
    r = r->next;
  }
  release(&kmem.lock);

  return total;
}


// proc.c
...
int
freeprocs()
{
  struct proc *p;

  int total = 0;
  for (p = proc; p < &proc[NPROC]; p++) {
    if (p->state != UNUSED)
      total++;
  }
  return total;
}
...

```

## copy from kernel space to user space

可以稍微看下从内核空间拷贝到用户空间的代码，这里是这么做的，

```c
// Copy from kernel to user.
// Copy len bytes from src to virtual address dstva in a given page table.
// Return 0 on success, -1 on error.
// 注意这里的第二个参数是用户空间的地址，第三个参数是实际需要拷贝的数据所在位置
int
copyout(pagetable_t pagetable, uint64 dstva, char *src, uint64 len)
{
  uint64 n, va0, pa0;

  while(len > 0){
    va0 = PGROUNDDOWN(dstva);				// 向下对齐到 page size，是以 page size 为基础的 copy
    pa0 = walkaddr(pagetable, va0);	// 根据用户空间的页表，找到实际的物理地址
    if(pa0 == 0)
      return -1;
    n = PGSIZE - (dstva - va0);		// 当前页面从 dstva 到剩余的地址空间的大小
    if(n > len)	// 如果当前这个 page 的大小小于 len，那么就以更小的 len 为准了，不能拷贝多了
      n = len;
    memmove((void *)(pa0 + (dstva - va0)), src, n);

    len -= n;	// 如果当前页面只靠 copy 了部分内容，那么需要接着下一个页面继续 copy
    src += n;
    dstva = va0 + PGSIZE;
  }
  return 0;
}
```

# 感受

重新做了一下 syscall，感觉还是很舒服，继续加油，冲哇！
