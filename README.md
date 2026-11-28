# PICO-8 Lua Language Server

English | [简体中文](README.zh-CN.md)

PICO-8 Lua Language Server (PICO-8-LS) is a Visual Studio Code extension with a language server for the Lua dialect of PICO-8. It works on `.p8` carts and on the `.lua` files that belong to them. Its reference for valid code is PICO-8 0.2.7.

## Features

- Syntax highlighting of every section of a cart, from `__lua__` to `__music__`.
- Errors that follow PICO-8 0.2.7, and warnings for undefined variables.
- An outline of definitions, in which table members are grouped under their table. Breadcrumbs and sticky scroll show the same outline.
- Go to Definition, Find References, hover with doc comments, completion and parameter hints. Find References, hover, completion and parameter hints also cover PICO-8's API.
- Go to Symbol in Workspace.
- Folding of functions, blocks, long comments, `-->8` tabs, `#region` markers and cart sections.
- `#include` of `.lua` files, of other carts and of single tabs of other carts.
- Snippets for `function`, `if`, `for` and `while`, and for the glyphs of PICO-8's font, such as `p8-heart` for ♥.

## Errors

PICO-8-LS marks the first error at the token where PICO-8 stops reading the code. PICO-8 itself names the line on which the statement with the error begins, so the two lines can differ. Errors after the first may be less exact. While a cart has an error, its undefined-variable warnings are not shown. They are not shown either for a cart that refers to its global table `_ENV`, for example to create globals from a string, because such a cart can define globals that the analysis cannot see. Where `_ENV` is a local variable, a parameter or a loop variable, a name that no local declares is a field of that table, so it gets no undefined-variable warning, and an assignment to it does not define a global. Go to Definition, hover, completion, Find References and parameter hints still take such a name as the global of that name, since tables used this way often inherit their globals through `__index`.

PICO-8-LS checks these limits of PICO-8:

- 200 levels of nested blocks and expressions;
- 200 local variables in a function, and 141 at the top level of a cart;
- 255 upvalues in a function;
- 8,192 tokens in a cart;
- 65,536 characters in a cart.

It does not check the register limit, which PICO-8 reports as "function or expression too complex", or a few rare cases that PICO-8 rejects.

## `#include`

An `#include` at the start of a line of a cart pastes the code of the named file in its place, as in PICO-8. Code can therefore run from one file into the other. `#include other.p8` includes the code of another cart, and `#include other.p8:2` includes only its tab 2, counting from 0 as PICO-8's editor does. An `#include` inside an included file is not followed, and it is reported as an error, as in PICO-8.

## Which `.lua` files are PICO-8 Lua

A `.lua` file is PICO-8 Lua when it is in a folder that holds a `.p8` file or in a folder below one. It is also PICO-8 Lua when a `.p8` file or another PICO-8 Lua file includes it. Other `.lua` files stay plain Lua. A language chosen for a file with Change Language Mode or `files.associations` is kept.

## Large workspaces

PICO-8-LS skips the files and folders that `files.exclude` hides. When the PICO-8 files of the workspace hold more than about 20 million characters, PICO-8-LS analyses only some of them. These are the open files, the files that include them, directly or through other files, and the files those include. Problems are then shown only for the open files, and a message says so once. To restore the features for the whole workspace, exclude large folders with `files.exclude`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pico-8-ls.maxNumberOfProblems` | `100` | Sets the maximum number of problems shown for a file. |
| `pico-8-ls.trace.server` | `off` | Logs the messages between VS Code and the language server, for debugging. |
| `pico-8-ls.outline.showParameters` | `false` | Lists the parameters of each function in the outline, breadcrumbs, sticky scroll and Go to Symbol in Workspace. |
| `pico-8-ls.outline.showLoopVariables` | `false` | Lists the variables of each `for` loop in the outline, breadcrumbs, sticky scroll and Go to Symbol in Workspace. |
| `pico-8-ls.outline.showBlocks` | `false` | Groups the outline, breadcrumbs and sticky scroll by the blocks that hold their entries, such as `for` loops and `if` branches. |

## Known issues

- Formatting is turned off, because the formatter could change what code means.
- While a renamed folder is being scanned, editing an open file can show a false warning for up to about a second.

## Development

Build and test with these commands, run from the repository root:

```sh
npm install
npm run compile
npm run lint
cd server && npm run test
```

`npm install` also installs the packages of the client and the server. `npm run compile` bundles both into `client/out-min` and `server/out-min`. In VS Code, the Launch Client configuration opens a window with the extension loaded. To build a package, run `npx @vscode/vsce package`, then install the `.vsix` file with Extensions: Install from VSIX.

## Credits and license

PICO-8-LS is based on [PICO-8 LS](https://github.com/japhib/pico8-ls) by JanPaul Bergeson. Its parser derives from [luaparse](https://github.com/fstirlitz/luaparse). PICO-8 is made by Lexaloffle Games. PICO-8-LS is released under the MIT license, as stated in [LICENSE](LICENSE).
