# PICO-8 Lua Language Server

[English](README.md) | 简体中文

PICO-8 Lua Language Server（PICO-8-LS）是一个 Visual Studio Code 扩展，为 PICO-8 的 Lua 方言提供语言服务器。它适用于 `.p8` 卡带，以及属于这些卡带的 `.lua` 文件。判断代码是否有效时，它以 PICO-8 0.2.7 为准。

## 功能

- 卡带中每个段的语法高亮，从 `__lua__` 到 `__music__`。
- 遵循 PICO-8 0.2.7 的错误报告，以及未定义变量的警告。
- 列出定义的大纲，表的成员归在所属的表下。痕迹导航和粘滞滚动显示同一份大纲。
- 转到定义、查找所有引用、带文档注释的悬停、代码补全和参数提示。其中查找所有引用、悬停、代码补全和参数提示也覆盖 PICO-8 的 API。
- 转到工作区中的符号。
- 折叠函数、代码块、长注释、`-->8` 标签页、`#region` 标记和卡带的各个段。
- 用 `#include` 包含 `.lua` 文件、其他卡带，或其他卡带的单个标签页。
- `function`、`if`、`for` 和 `while` 的代码片段，以及 PICO-8 字体中字形的代码片段，例如用 `p8-heart` 输入 ♥。

## 错误

PICO-8-LS 把第一个错误标在 PICO-8 停止读取代码的那个 token 上。PICO-8 自身报告的是出错语句开始的那一行，所以两者的行号可能不同。第一个错误之后的错误可能不够精确。卡带有错误时，不显示它的未定义变量警告。卡带的代码用到全局表 `_ENV` 时，比如用字符串创建全局变量，也不显示未定义变量警告，因为这样的卡带可以定义分析看不到的全局变量。在 `_ENV` 是局部变量、参数或循环变量的地方，没有被局部声明的名字是这张表的字段，所以不会得到未定义变量警告，给它赋值也不算定义全局变量。转到定义、悬停、补全、查找引用和参数提示仍然把这样的名字当作同名的全局变量，因为这样用的表通常通过 `__index` 继承全局变量。

PICO-8-LS 检查 PICO-8 的以下限制：

- 代码块和表达式的嵌套：200 层；
- 局部变量：一个函数中 200 个，卡带顶层 141 个；
- 上值（upvalue）：一个函数中 255 个；
- token：一个卡带中 8,192 个；
- 字符：一个卡带中 65,536 个。

它不检查寄存器上限（PICO-8 报告为 "function or expression too complex"），也不检查少数几种 PICO-8 会拒绝的罕见情况。

## `#include`

卡带中位于行首的 `#include` 会把所指文件的代码粘贴到该位置，与 PICO-8 相同。因此，代码可以从一个文件延续到另一个文件。`#include other.p8` 包含另一个卡带的代码，`#include other.p8:2` 只包含它的 2 号标签页，编号与 PICO-8 编辑器一样从 0 开始。被包含文件中的 `#include` 不会展开，并且与 PICO-8 一样报告为错误。

## 哪些 `.lua` 文件属于 PICO-8 Lua

位于含有 `.p8` 文件的文件夹或其下级文件夹中的 `.lua` 文件属于 PICO-8 Lua。被 `.p8` 文件或另一个 PICO-8 Lua 文件包含的 `.lua` 文件也属于 PICO-8 Lua。其他 `.lua` 文件仍是普通 Lua。通过“更改语言模式”或 `files.associations` 为文件选择的语言会被保留。

## 大型工作区

PICO-8-LS 跳过 `files.exclude` 隐藏的文件和文件夹。当工作区中的 PICO-8 文件合计超过约 2000 万个字符时，PICO-8-LS 只分析其中一部分。这部分包括打开的文件、直接或间接包含它们的文件，以及这些文件所包含的文件。此时只有打开的文件显示问题，并有一条消息说明一次。要让功能恢复覆盖整个工作区，请用 `files.exclude` 排除大型文件夹。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `pico-8-ls.maxNumberOfProblems` | `100` | 设置每个文件最多显示的问题数。 |
| `pico-8-ls.trace.server` | `off` | 记录 VS Code 与语言服务器之间的消息，用于调试。 |
| `pico-8-ls.outline.showParameters` | `false` | 在大纲、痕迹导航、粘滞滚动和转到工作区中的符号中列出每个函数的参数。 |
| `pico-8-ls.outline.showLoopVariables` | `false` | 在大纲、痕迹导航、粘滞滚动和转到工作区中的符号中列出每个 `for` 循环的变量。 |
| `pico-8-ls.outline.showBlocks` | `false` | 在大纲、痕迹导航和粘滞滚动中，按包含条目的代码块分组，例如 `for` 循环和 `if` 分支。 |

## 已知问题

- 格式化已关闭，因为格式化程序可能改变代码的含义。
- 重命名的文件夹正在扫描时，编辑打开的文件可能出现一个误报的警告，最多持续约一秒。

## 开发

在仓库根目录运行以下命令来构建和测试：

```sh
npm install
npm run compile
npm run lint
cd server && npm run test
```

`npm install` 也会安装客户端和服务器的包。`npm run compile` 把两者打包到 `client/out-min` 和 `server/out-min`。在 VS Code 中，`Launch Client` 启动配置会打开一个已加载本扩展的窗口。要构建安装包，请运行 `npx @vscode/vsce package`，然后用“扩展: 从 VSIX 安装”命令安装生成的 `.vsix` 文件。

## 致谢与许可证

PICO-8-LS 基于 JanPaul Bergeson 的 [PICO-8 LS](https://github.com/japhib/pico8-ls)。它的解析器源自 [luaparse](https://github.com/fstirlitz/luaparse)。PICO-8 由 Lexaloffle Games 制作。PICO-8-LS 以 MIT 许可证发布，见 [LICENSE](LICENSE)。
