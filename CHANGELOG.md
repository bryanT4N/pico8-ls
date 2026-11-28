# Changelog

This file lists the main changes in each version of PICO-8 Lua Language Server (PICO-8-LS), in the style of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions 0.1.0 to 0.7.1 were built locally and not published. Version 0.8.0 is the first version published to the Visual Studio Marketplace. Version 0.1.0 starts from PICO-8 LS 0.8.0, whose history is in the [PICO-8 LS changelog](https://github.com/japhib/pico8-ls/blob/master/CHANGELOG.md).

## 0.8.1

### Added

- Hover, completion and parameter hints for `inext`, `rawequal` and `ls`.

### Changed

- A cart that refers to its global table `_ENV`, for example to create globals from a string, gets no undefined-variable warnings, because it can define globals that the analysis cannot see.

### Fixed

- Names that PICO-8 0.2.7 defines for every cart, such as `inext`, `rawequal` and `ls`, are not reported as undefined variables.
- Where `_ENV` is a local variable, a parameter or a loop variable, as in `for _ENV in all(objects)`, a name that no local declares gets no undefined-variable warning, and an assignment to it does not define a global. The outline lists such an assignment as `_ENV.name`.
- Completion no longer offers `rawequals` and `coyield`, which PICO-8 does not have, and code that reads them gets an undefined-variable warning.
- Hover and parameter hints show correct signatures for `music`, `tline`, `chr`, `ipairs`, `map` and `mapdraw`, and parameter hints cover `t`, `time`, `reset` and `info`. The descriptions of `t` and `time` follow PICO-8's manual.

## 0.8.0

### Added

- Checks of PICO-8's limits on local variables, upvalues, tokens and characters.
- Files and folders that `files.exclude` hides are skipped.
- A workspace whose PICO-8 files hold more than about 20 million characters is analysed in part: the open files, the files that include them and the files those include. A message says so.

### Changed

- The extension is named PICO-8 Lua Language Server and has its own icon.
- Errors follow PICO-8 0.2.7. The first error is at the token where PICO-8 stops reading.
- Error messages quote code as PICO-8 does.
- PICO-8's additions to Lua, such as one-line `if (...)`, compound assignments like `+=`, and `?`, are read as PICO-8 0.2.7 reads them.
- `#include` pastes the code of the named file in place of its line, so code can run from one file into the other.
- Carts are read as PICO-8 reads them, including their header, sections and line breaks.
- While a cart has an error, its undefined-variable warnings are not shown.

### Removed

- The error recovery that used indentation to guess where an unfinished block ends. It kept the outline of code with errors closer to its intended shape, but it could put the first error in the wrong place.

### Fixed

- `//` comments are coloured as comments in `.lua` files, and a `//` inside a string is not.
- Creating, renaming or deleting a folder while the workspace is open updates the analysis.
- An included file reached through a junction, a `subst` drive, a short 8.3 name or a folder name in another case is taken as one file, not two.
- On Windows, `#include` reads a name as Windows reads a path, so `lib.lua.` finds `lib.lua`, as in PICO-8.

## 0.7.1

### Removed

- Formatting, because the formatter could change what code means.

## 0.7.0

### Changed

- A request that fails gets an empty answer.
- `#region` and `#endregion` mark regions only in line comments.
- A file that `files.associations` gives a language other than PICO-8 or PICO-8 Lua shows no PICO-8 warnings.

### Fixed

- Folding, the outline and hover work on deeply nested code and very long expressions.

## 0.6.0

### Added

- Three outline settings: `pico-8-ls.outline.showParameters`, `pico-8-ls.outline.showLoopVariables` and `pico-8-ls.outline.showBlocks`.
- A rule for which `.lua` files are PICO-8 Lua. Other `.lua` files stay plain Lua.

### Changed

- The extension starts when a PICO-8 file is opened or when the workspace contains a `.p8` file.

## 0.5.0

### Added

- Go to Symbol in Workspace.
- Workspace folders that are added are read, and folders that are removed are forgotten.

## 0.4.0

### Added

- Hover for names defined in the workspace, with their declaration and doc comment.
- The declaration and doc comment of a completion item when it is expanded.
- Parameter hints for functions defined in the workspace.

## 0.3.0

### Changed

- One analysis of the whole project serves the outline, Go to Definition, Find References, completion and warnings.
- Names from an included file are scoped as if its code were pasted in place of the `#include` line.
- Changes made to files outside VS Code are picked up.

## 0.2.0

### Changed

- The outline, folding and errors keep working while code is being typed.
- After five crashes within three minutes, the language server is not restarted.

### Fixed

- An `#include` cycle at the end of an included file is reported instead of hanging the language server.
- `pico-8-ls.maxNumberOfProblems` takes effect.

## 0.1.0

### Changed

- The extension ID is `bryanT4N.pico-8-ls`, and commands and settings use the `pico-8-ls.` prefix.
- The outline lists definitions, and table members are grouped under their table.
- Folding does not depend on the outline.
