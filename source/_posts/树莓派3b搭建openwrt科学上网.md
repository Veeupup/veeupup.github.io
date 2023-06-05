---
title: 树莓派3b搭建openwrt科学上网
date: 2023-05-03 21:22:27
categories:
- 折腾
tags:
- 科学上网
---

本文记录下采用树莓派来搭建软路由实现科学上网的过程，中间没有想象的那么顺利…折腾了大概两个小时才弄完，这里记录下整个流程和一些坑。

<!-- more -->

# 树莓派刷 openwrt

## 下载 openwrt 镜像

首先去下载固件给树莓派刷系统，下载的地址为：

> 定制固件下载地址：[https://doc.openwrt.cc/2-OpenWrt-Rpi/1-Download/](https://links.jianshu.com/go?to=https%3A%2F%2Fdoc.openwrt.cc%2F2-OpenWrt-Rpi%2F1-Download%2F)
>
> 作者项目地址：[https://github.com/SuLingGG/OpenWrt-Rpi](https://links.jianshu.com/go?to=https%3A%2F%2Fgithub.com%2FSuLingGG%2FOpenWrt-Rpi)

目前我使用的型号是 3B+，下载 `immortalwrt-bcm27xx-bcm2710-rpi-3-squashfs-sysupgrade.img.gz`即可。

## 刷写固件

下载 [BalenaEtcher](https://links.jianshu.com/go?to=https%3A%2F%2Fwww.balena.io%2Fetcher%2F)，安装，然后插上TF卡转接器，它会自动检测到USB设备，开始刷系统

> 我这里遇到了刻录失败的情况，原因是 TF 卡未格式化完全，去这里下载 TF 卡格式化软件并且进行完全格式化
>
> https://doc.embedfire.com/openwrt/user_manal/zh/latest/User_Manual/quick_start/imageflash.html

刷写完成后，弹出"U盘"，取下TF卡，装到树莓派中，通电等待30秒**（不要插网线）**。

## 网络配置

等树莓派启动之后会默认开启一个名叫 `OpenWRT` 的WIFI，可以直接连接，连接成功之后访问 http://192.168.1.1。

默认账号：`root`，默认密码：`password`。进去之后可以先修改密码。

在 `网络 -> 接口` 中可以看到当前有一个 LAN 口设置，这是树莓派 3B+ 本身的无线 AP 的设置，也就是最终外部设备访问树莓派网络的接口，进去进行一些设置：

* **然后点击 `高级设置` ，取消勾选 `以太网适配器: "eth0"`，点击保存与应用。**

![LAN口设置](LAN_setting.png)

> 除此之外，由于我从另外一个路由器的 LAN 口接出来，本身的网段也是 `192.168.0.x`，所以这里把 LAN 口的网段改成了 `192.168.2.x`，避免冲突

随后进行 WAN 的设置，也就是树莓派本身接入网络的设置，这里我是直接从另外一个路由器的 LAN 口接出来的网线，所以直接选择 DHCP 客户端即可。

![image-20230503213619032](WAN_setting.png)

到这里 LAN 口和 WAN 口都配置完毕，可以在 web 界面中的 `系统 -> TTYD终端` 来尝试 ping baidu.com 看是否连接上了 WAN 口；电脑连接 OpenWRT WIFI 看是否能连接以及上网。

到这里其实应该结束了，但是我发现我这里的 LAN 口和 WAN 之间并没有路由规则，因为两个属于不同的网段，所以我在 iptable 里添加了这么一条规则

`iptables -t nat -I POSTROUTING -o eth0 -j MASQUERADE`

> 来自 chatGPT 的解释：
>
> 这个命令的作用是在Linux系统中使用iptables工具配置NAT(Network Address Translation，网络地址转换)，将私有网络IP地址转换为公有网络IP地址，以实现互联网访问的功能。
>
> 具体来说，这个命令添加了一个POSTROUTING规则，在NAT表中（-t nat），用于转发通过eth0网络接口出去的所有IP数据报（-o eth0）。添加MASQUERADE目标（-j MASQUERADE）意味着源IP地址被掩盖成eth0的IP地址，从而实现了内网地址（如192.168.x.x）到外网地址（如公网IP地址）的映射，这样就可以访问公网。

到此为止树莓派已经能够正常作为一个路由器使用了。

# openclash

之后就是配置 openclash 的过程，在这个镜像里面已经内置了 openclash，所以不需要安装，如果需要安装参考这里：[openclash 安装](https://github.com/vernesong/OpenClash/wiki/%E5%AE%89%E8%A3%85)

进去添加 clash 订阅即可，记得勾选 “在线订阅转换”，才能将订阅链接替换成配置文件。

但是我到这里又不行了，openclash 启动不了，报错：

```shell
nohup: failed to run the command `/etc/openclash/clash`: Exec format error
```

这里是因为 clash 内核的版本对不上，可以直接尝试在页面中更新

`服务 -> openclash -> 插件设置 -> 版本更新`，选择已经编译版本为 armv7，点下面的检查并更新，但是又因为网络问题下载不了……难蚌

然后解决方式是手动下载然后替换掉 `/etc/openclash/clash` 文件即可，记得 `chmod +x clash`。

手动下载的地址为：https://github.com/vernesong/OpenClash/releases/tag/Clash，记得这里选中 armv7 版本下载即可，之后替换成功了，就能看到成功启动的日志了。

## 连接 WAN LAN 

我这边设置的 WAN 口和 LAN 口的网络属于两个网段，默认的防火墙配置是无法访问到的，这里需要配置 `网络 -> 防火墙` 中来自 WAN 的流量都接受，同时设置端口转发规则将

# reference

* basic 参考 https://www.jianshu.com/p/1d9f45197627
* https://github.com/vernesong/OpenClash
* LAN口和WAN的 route 规则 https://www.right.com.cn/forum/thread-3218146-1-1.html
* https://zhuanlan.zhihu.com/p/451788328
* flash 刷写不成功 https://doc.embedfire.com/openwrt/user_manal/zh/latest/User_Manual/quick_start/imageflash.html
