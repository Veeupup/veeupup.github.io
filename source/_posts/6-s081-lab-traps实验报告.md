---
title: 6.s081-lab traps实验报告
date: 2022-03-25 13:55:45
categories:
- 6.s081
---

这个实验是要学会了解 xv6 的进行 trap 的机制的原理，首先得看 xv6 book 搞清楚整个系统调用的流程，首先是简单的 trap 的系统流程的介绍，这里对原理不做太多的介绍，可以看参考资料

# Backtrace

backtrace 是需要实现打印出 stack 中的每个 stackframe 的返回地址的函数，其中有一张图可以看到 return address 是在当前栈指针的 -8 offset 的位置，然后前一个栈指针保存在 -16 offset 的位置，所以不断迭代的去找这个 return address 并且打印出来即可，在 xv6 中，stack 是一个 page 的大小，所以通过 `PGROUNDUP` 找到栈顶的位置来进行循环的退出即可

```c
void 
backtrace(void)
{
  uint64 fp = r_fp();
  uint64 last = PGROUNDUP(fp);
  while (fp < last) {
    uint64 ret_addr = *(uint64*)(fp - 8);
    printf("%p\n", ret_addr);
    fp = *(uint64*)(fp - 16);
  }
}

```

# Alarm

## test0

test0 是需要在给当前进程时钟在时钟中断定期触发时进行函数的调用，所以需要结合系统调用的过程来做一些修改，首先看一下正常的流程

1. `ecall`指令中将PC保存到SEPC
2. 在`usertrap`中将SEPC保存到`p->trapframe->epc`
3. `p->trapframe->epc`加4指向下一条指令
4. 执行系统调用
5. 在`usertrapret`中将SEPC改写为`p->trapframe->epc`中的值
6. 在`sret`中将PC设置为SEPC的值

在系统调用结束之后返回到用户空间之后下一次执行的地址是在 PC+4 的位置，而现在我们希望返回到用户空间之后是执行用户给定的 `handler` 函数，所以在 `sret` 的时候修改下这个地址即可，注意同时将 proc 中的 tick 进行归 0

```c
/**
	proc.h
*/
struct proc {
	...
  // for alarm
  int interval;                
  int ticks;
  void (*alarm_handler)();
  ...
}

/**
	proc.c
*/
uint64 sys_sigalarm(void) {
  if(argint(0, &myproc()->interval) < 0 ||
    argaddr(1, (uint64*)&myproc()->alarm_handler) < 0)
    return -1;

  return 0;
}

/**
usertrap()
*/
// give up the CPU if this is a timer interrupt.
if(which_dev == 2) {
    if(++p->ticks_count == p->alarm_interval) {
        // 更改trapframe中的 PC，回到用户空间之后就会从这个地址开始执行
        p->trapframe->epc = (uint64)p->alarm_handler;
        p->ticks_count = 0;
    }
    yield();
}
```

注意proc在alloc和 free 的时候对这些变量进行清理和初始化工作。

## test1/test2

test0 的实现其实是有问题的：当返回到用户空间来执行 `handler` 函数的时候，handler 函数可能会修改此时寄存器中的内容，因为这个时候返回到用户空间的时候并，然后在再次返回到用户空间执行 pc + 4 的代码的时候就发现寄存器内容被修改了，不能正常工作了，因为这个时候调用`handler` 函数也类似一次中断，因为需要执行 pc 以外的函数，但是这个时候没有中断机制帮助我们做 context 的恢复，所以这个时候需要手动模仿 中断的处理流程把当前的 trapframe 保存一下即可。

所以在进行执行 `handler` 函数的时候也需要一个专门 trapframe 来保存在 handler 触发之前的函数的一个 context，然后再修改 trapframe->epc 来执行 `handler` 函数

```c
// trap.c
void
usertrap(void) {
  ...
    if(which_dev == 2) {
      if(p->interval != 0 && ++p->ticks == p->interval && p->is_alarming == 0) {
        // 保存寄存器内容到 alarm_trapframe 因为此时返回到用户空间的地址是 epc
        // epc 是 alarm_handler 的地址，然后执行完毕之后再调用 sigreturn 函数
        // 这个时候把 trapframe 的 epc 改成了之前正常执行的 epc 了，然后应用程序代码继续正常执行
        memmove(p->alarm_trapframe, p->trapframe, sizeof(struct trapframe));
        // 更改陷阱帧中保留的程序计数器，注意一定要在保存寄存器内容后再设置epc
        p->trapframe->epc = (uint64)p->alarm_handler;
        p->ticks = 0;
        p->is_alarming = 1;
      }
      yield();
    }
...
}

// 注意恢复这个 trapframe
uint64
sys_sigreturn(void) {
  memmove(myproc()->trapframe, myproc()->alarm_trapframe, sizeof(struct trapframe));
  myproc()->is_alarming = 0;
  return 0;
}
```

tips：

* 注意第一个 `sigalarm` 只是注册这个函数和时钟计时器相关，并不是真正执行，代码还会继续走，然后再过两个 tick 之后才会触发这个函数



# 参考资料

* https://zhuanlan.zhihu.com/p/351939252
