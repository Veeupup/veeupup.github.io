---
title: 6.s081-lab-util-实验报告
date: 2022-01-03 19:33:40
categories:
- 6.s081
---

欠下的技术债总是要还的..., 上次因为实习中断了第一次学习 6.s081 的学习，实在是不应该 TAT, 现在重新开始学习做 lab, 为了这次监督自己，开始写实验报告，一个是为了自己以后能够快速回忆起来思路，另一个方面是为了督促自己这次完整的做完，所以废话不多说，开始记录第一个 lab 的内容。

# Totally Intro
这个实验总体上是一个比较简单的实验, 通过写几个用户态的小程序, 搭建好开发环境, 熟悉 xv6 的代码, 并且熟悉一些常见的系统调用，`fork`, `exec`, `sleep` ,以及一些常见的 shell 命令
> 注意这里可能有些坑, 在装 qemu 的时候，可以手动源码安装 5.x 版本, 6.x 版本在 macos 上会有些奇怪的问题。

# sleep

这个非常简单，就是尝试使用一下 sleep 系统调用，第一个快速上手的代码, 从输入的参数, 注意在 makefile 中添加下 sleep 的路径即可。

```c
#include "kernel/types.h"
#include "kernel/stat.h"
#include "user/user.h"

int
main(int argc, char* argv []) {
  if (argc != 2) {
    fprintf(2, "usage: sleep seconds\n");
    exit(1);
  }

  int seconds = atoi(argv[1]);
  if (seconds < 0) {
    seconds = 0;
  }

  sleep(seconds);

  exit(0);
}
```
# pingpong

这里涉及到对于 `fork`, `pipe`, `read`, `getpid` 等系统调用的综合使用，简单来说就是熟悉下这几个系统调用的使用方式，注意下 `pipe[2]` 中 `pipe[0]` 是 `READ`, `pipe[1]` 是 `WRITE`, 建议写成常量的形式，免得写错。

```c
#include "kernel/types.h"
#include "kernel/stat.h"
#include "user/user.h"

#define PIPE_READ  0
#define PIPE_WRITE 1

int
main(int argc, char* argv []) {
  if (argc != 1) {
    fprintf(2, "usage: pingpong\n");
    exit(1);
  }

  int p1[2];  // parent -> child
  int p2[2];  // child  -> parent
  pipe(p1);
  pipe(p2);

  if (fork() == 0) {  // in child
    char buf[4];
    read(p1[PIPE_READ], &buf, 4);
    printf("%d: received %s\n", getpid(), buf);
    write(p2[PIPE_WRITE], "pong", 4);
    exit(0);
  }
  else {
    write(p1[PIPE_WRITE], "ping", 4);
    char buf[4];
    read(p2[PIPE_READ], &buf, 4);
    printf("%d: received %s\n", getpid(), buf);
    wait(0);
  }

  exit(0);
}
```
# primes

这个非常有意思的一个小程序, 用 CSP 的思想来实现的一个程序, 也就是用 `pipe` 和 `fork` 来达到现在 `golang` 里 channel 的通信效果来完成对于质数的查找，完整的思路在这个链接 http://swtch.com/~rsc/thread/, 思路在于这个图

<img src="primes.gif" />

伪代码如下：

```python
p = get a number from left neighbor
print p
loop:
    n = get a number from left neighbor
    if (p does not divide n)
        send n to right neighbor
```

首先输入查找的质数范围，然后每次启动一个进程来进行质数的筛选，每个进程的第一个数字一定是质数，然后这个进程之后接收的数字使用当前的第一个数字来进行质数的排除即可。

这个思路很清晰了，但是实现上还是比较巧妙的，自己这个也不一定是最好的实现方式，但是写起来很有趣，对于 系统调用以及 CSP 的思想的理解更深了一点

```c
#include "kernel/types.h"
#include "kernel/stat.h"
#include "user/user.h"

#define PIPE_READ  0
#define PIPE_WRITE 1

void primes(int* p) {
  if (fork() == 0) {
    int first;
    if (read(p[PIPE_READ], &first, 4) == 0)
      exit(0);
    printf("prime %d\n", first);
    int number;
    int p2[2];
    pipe(p2);
    while (read(p[PIPE_READ], &number, 4) > 0) {
      if (number % first != 0) {
        write(p2[PIPE_WRITE], &number, 4);
      }
    }
    close(p2[PIPE_WRITE]);

    primes(p2);
    wait(0);

    exit(0);
  }
}

int
main(int argc, char* argv []) {
  if (argc != 1) {
    fprintf(2, "usage: pingpong\n");
    exit(1);
  }

  int p[2];  // parent -> child
  pipe(p);

  for (int i = 2; i < 35; i++) {
    write(p[PIPE_WRITE], &i, 4);
  }
  close(p[PIPE_WRITE]);

  primes(p);
  wait(0);

  exit(0);
}

```

# find

实现一个 `find`，主要是对于文件系统的一些概念的理解，根据 `ls` 程序直接改动可能是最好做的方式了，注意 `fmtname` 的实现即可。

```c
#include "kernel/types.h"
#include "kernel/stat.h"
#include "user/user.h"
#include "kernel/fs.h"

char*
fmtname(char* path) {
  static char buf[DIRSIZ + 1];
  char* p;

  // Find first character after last slash.
  for (p = path + strlen(path); p >= path && *p != '/'; p--)
    ;
  p++;

  // Return blank-padded name.
  if (strlen(p) >= DIRSIZ)
    return p;
  memmove(buf, p, strlen(p));
  buf[strlen(p)] = '\0';
  return buf;
}

void
find(char* path, char* file) {
  char buf[512], * p;
  int fd;
  struct dirent de;
  struct stat st;

  if ((fd = open(path, 0)) < 0) {
    fprintf(2, "find: cannot open %s\n", path);
    return;
  }

  if (fstat(fd, &st) < 0) {
    fprintf(2, "find: cannot stat %s\n", path);
    close(fd);
    return;
  }

  switch (st.type) {
  case T_FILE:
    break;

  case T_DIR:
    if (strlen(path) + 1 + DIRSIZ + 1 > sizeof buf) {
      printf("find: path too long\n");
      break;
    }
    strcpy(buf, path);
    p = buf + strlen(buf);
    *p++ = '/';
    while (read(fd, &de, sizeof(de)) == sizeof(de)) {
      if (de.inum == 0)
        continue;
      memmove(p, de.name, DIRSIZ);
      p[DIRSIZ] = 0;
      if (stat(buf, &st) < 0) {
        printf("find: cannot stat %s\n", buf);
        continue;
      }

      char* name = fmtname(buf);
      if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0)
        continue;

      if (strcmp(name, file) == 0) {
        printf("%s\n", buf);
      }
      find(buf, file);
    }
    break;
  }
  close(fd);
}

int
main(int argc, char* argv []) {
  if (argc != 3) {
    fprintf(2, "usage: find path file\n");
    exit(1);
  }

  find(argv[1], argv[2]);

  exit(0);
}

```

# xargs

这个比较有意思，实现一个 `xargs` 的程序，`xargs` 的语意是将两个 pipe 连接起来的 command，前面一个的输入作为后面一个 command 的命令参数，这里有一个很坑的点，那就是需要 `fork` 出来一个进程 `exec` 执行，因为如果直接执行的话，这里得到的命令行参数会混淆有影响

```c
#include "kernel/types.h"
#include "kernel/stat.h"
#include "user/user.h"
#include "kernel/param.h"

int
main(int argc, char* argv []) {
  char* params[MAXARG];
  int i = 0;
  for (; i < argc - 1; i++) {
    params[i] = argv[i + 1];
  }

  char buf[512];
  int len = read(0, &buf, 512);
  int start = 0;
  int end = 0;
  while (end < len) {
    while (buf[end] != '\n') {
      end++;
      continue;
    }

    if (start == end)
      break;

    char param[512];
    memset(param, '\0', 512);
    memcpy(param, buf + start, end - start);
    params[i] = param;
    if (fork() == 0) {
      exec(params[0], &params[0]);
    }
    else {
      wait(0);
    }

    start = ++end;
  }

  exit(0);
}

```

