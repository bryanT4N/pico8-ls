# Changelog

## 0.4.0 (unreleased)

- Hover shows your own functions, variables, fields, parameters and labels: their declaration, such as `function vector:dot(v2)` or `(global) g_debug = false`, and the comment written right above them.
  - A variable or field shows its value when that is written as a number, a short string, `true`, `false` or `nil`, and `{…}` for a table. The value comes from a plain assignment, never from `x -= 1` and the like, and a string that runs over several lines is not shown.
  - A method call that the table itself does not define, for example one inherited through `extend`, shows every method of that name with its table.
- Which comments are shown:
  - A block of comment lines right above the line where a name is defined, with no blank line between. Plain `--` and `//` comments count, and so do `---` and `--[[ ]]`.
  - For a variable, table or field, a `--` or `//` comment at the end of its last line, when no comment above documents it.
  - For a name set in several places, the comment is looked for where Go to Definition goes: its first definition in each file, and each function definition.
  - Not shown: a tab's name (the comment right after `-->8`), the title at the top of a file, a heading, and commented-out code. A heading is a block whose last line is a row of `-`, `=`, `*` or similar characters, or a single line of text between two runs of them, as in `-- ==== player ====`.
  - LDoc tags such as `@param` and `@return` are listed after the description; `@param name text` also documents that parameter.
- Expanding a completion item shows the same declaration and comment.
- A function of your own that has the name of a built-in one, such as `print`, shows as yours in hover, completion and parameter hints.
- Parameter hints work for your own functions, with their comment and each parameter's `@param` text:
  - Called with `:`, a function not declared with `:`, such as `obj.m = function(self, x)`, leaves out its first parameter, which takes the table, whatever its name, unless it is `...`. A function declared with `:` but called with `.` shows `self` first.
  - A method that the table itself does not define, for example one inherited through `extend`, shows every method of that name with its table.
  - When several functions may be called, the first whose parameters take the arguments typed so far is selected.
- Parameter hints, also for PICO-8's built-in functions, now find the call when it is inside another call, contains strings or comments, or runs over several lines.
  - Inside the body of a function passed as an argument, as in `foreach(t, function(e)`, the call it is passed to shows no hint; calls written in the body show theirs. A call on something other than a name, such as `f(x)(` or `get():hit(`, shows none.
  - Inside a `{` or `[` in the arguments, as in `spr({1, `, no parameter is marked.
- Fixed: a file that an `#include` read from disk before you opened it, for example in a folder outside the workspace or in a folder whose name starts with a dot, showed its old text in its outline and Go to Definition until you edited it.
- Fixed: after a folder of included files was deleted, its files, also those included only from other files in the folder, kept their own warnings, and when the files were created again the `#include` kept reporting a missing file until the including file was edited.
- Fixed: fields that an included file sets on a function of the including file were listed without the function's name in the included file's outline.
- Creating a file no longer analyses every cart in the workspace again.

## 0.3.0 (unreleased)

- The outline, Go to Definition, Find References, completion and "undefined variable" warnings now come from one analysis of the whole project, so they agree with each other.
- Go to Definition and Find References:
  - Names follow Lua's scoping: a `local` is found only where it is visible, a loop variable only inside its loop, and in `local x = x` the right-hand `x` is the outer one.
  - Fields and methods are found through their table: `player.x` goes to `x = 64` in `player = { x = 64 }`, and `a:update()` no longer lists `b:update`.
  - A field read such as `x = player.hp` is found, and `self` works in callbacks inside a method.
  - A field read through a parameter, like `p.health` in `function hurt(p)`, no longer goes to fields of the same name on other tables, such as `game.health` in another file.
  - Labels are matched within their function.
  - Go to Definition goes where the outline lists a name: its first definition in each file, plus every function definition. A method call on a table that has no such method, for example one inherited through `extend`, lists every method of that name.
  - Find References honours "include declaration".
- Completion:
  - It offers the locals visible at the cursor, the project's globals and the built-in functions, with kinds and signatures.
  - After `player.`, `player:`, `self.` or `self:` it offers the table's fields and methods, only the methods after a colon.
  - It works on the line being typed, also in a function whose `end` is not written yet, and after `..`.
- Warnings:
  - New warnings where Lua would read an undefined global: a local function called from another function, a loop variable used after its loop, and a global that is only ever changed with `+=` and the like.
  - No false warning for a `repeat … until` condition that reads a local of the loop.
  - Names like `constructor` or `toString` no longer break the analysis.
  - A file included by several carts shows only the warnings that hold in every one of them.
- `#include` follows PICO-8's pasting: a `local` declared before the `#include` is visible in the included file, one declared after it is not, and an `#include` inside a function sees that function's locals. Unsaved edits to an included file show up in the files that include it.
- Outline:
  - Each file lists a global or field at its own first definition, also when another file defines it first.
  - Callbacks written in a variable's value are listed under it, so the breadcrumbs reach them.
  - `local f` followed by `function f()` lists only the function.
  - With several names in one assignment, each name gets its own range.
  - `x = x or { ... }` counts as a table, and `T[k] = v` between a table and its methods no longer keeps the methods from being grouped under it.
- Changes made outside VS Code, for example saving from PICO-8 or deleting a file, are picked up, and a file closed without saving goes back to its saved text.
- A new file, or one opened outside the workspace folders, gets Go to Definition and completion straight away, and an `#include` written before the file existed works as soon as it is created.
- Fixed: setting `pico-8-ls.maxNumberOfProblems` to null hid every problem, and a negative number dropped some of them. Now null means the default of 100 and a negative number means 0. The settings editor asks for a whole number of at least 0.
- Fixed: hovering over a name like `constructor` or `toString` showed an empty box. Hover, completion details and signature help now look up only PICO-8's own built-in functions.
- Fixed: a file whose name has characters such as parentheses, like `lib(2).lua`, now works with `#include`: edits to it show up in the files that include it, and it no longer gets false warnings of its own.

## 0.2.0 (unreleased)

- Fixed: the language server hung or crashed, and then kept restarting, when an included file's last line was an `#include` leading back to a file already being included, or when a file ended with an unfinished parameter list like `function foo(`.
- Fixed: a character the parser does not know, like a backtick, stopped the outline and errors from updating.
- While you type, the outline, folding, Go to Definition and errors keep working:
  - A block with a missing `end` keeps its contents, and the code after it is no longer swallowed into it. The error points at the block that is missing its `end`.
  - A statement that starts with a keyword, like `function` or `local`, is no longer hidden by an unfinished line before it, and the error is shown at the end of the unfinished line. A line that starts with a name can still be taken into an unfinished `x =` above it.
  - Syntax errors are no longer hidden by "undefined variable" warnings.
  - A `goto` whose label is not written yet no longer drops the whole function.
  - An unfinished string no longer shifts the line numbers of everything after it.
  - A `#` typed on a line of its own, on the way to an `#include`, no longer shifts the line numbers of everything after it.
  - In a `.p8` file, an unclosed `--[[` comment or `[[` string stops at the end of the code instead of running on into `__gfx__` and the sections after it.
- With `#include`:
  - Each file's folding shows only its own code.
  - A block left open at the end of an included file is reported in that file and no longer swallows the code after the `#include`.
  - An `#include` on the last line of an included file is resolved relative to that file, and its errors are shown.
  - `#include`s nested more than 32 levels deep, or more than 256 included files to parse in all, are reported, and symlinked files can be included.
  - An included file that cannot be read, for example because it is locked, is reported on its `#include` instead of freezing the file's outline and errors.
  - Formatting a file is no longer refused because an included file has errors.
- Tabs and regions:
  - A tab is named after the comment on its first line.
  - `-->8` starts a tab only on a line of its own, not after code.
  - `.lua` files with `-->8` get a tab 0 for the code before the first `-->8`, like `.p8` files.
  - An unclosed `#region` starts on its own line and stops at the end of its tab, or of the `__lua__` section when there are no tabs.
  - `#region` and `#endregion` count only at the start of a line, followed by a space or the end of the line.
  - In the outline, regions nest inside each other and inside tabs, and empty tabs are left out.
  - Tabs always stay at the top level of the outline: a region that runs into a later tab is listed inside the tab it starts in.
- Fixed: the `pico-8-ls.maxNumberOfProblems` setting had no effect. Each file now shows at most that many problems, 100 by default, syntax errors first.
- The extension stops restarting the language server after it crashes 5 times in 3 minutes, and says so.

## 0.1.0 (unreleased)

First version of PICO-8-LS, a personal fork of PICO-8 LS 0.8.0.

- New extension ID `bryanT4N.pico-8-ls`. Commands and settings use the `pico-8-ls.` prefix.
- The outline lists definitions instead of assignments:
  - Each global and each table member is listed once, at its first definition.
  - Table members, including fields set inside functions and `self.x` inside methods, are grouped under their table. Methods written right after their table are grouped under it too; otherwise they stay where they are, named like `player:update`.
  - Functions list their `local`s, but not their parameters or loop variables.
  - Fields set through parameters or loop variables are left out. Functions are always listed, so the code inside them can be found from the outline.
  - With `#include`, each file's outline lists only the definitions written in that file; members it adds to a table defined in another file are listed under an entry for that table.
- Folding no longer depends on the outline.
- Fixed: a function set on a field of an indexed table, like `btns[i].press = function() end`, showed up under an unrelated entry, or made the whole file fail to parse when it came before any other definition.
- Fixed: a broken `#include` inside an included file made the including file's outline and folding come from the included file.
- Fixed: a file whose last comment is a `-->8` tab marker lost its outline, diagnostics and go-to-definition.

## 0.8.0 (10/29/2026)

- Fix parse error on the line after a one-line `while (...)` statement (issue [#80](https://github.com/japhib/pico8-ls/issues/80))
- Fix formatter moving a comment directly after a function call inside the call's parentheses (issue [#53](https://github.com/japhib/pico8-ls/issues/53))
- Fix parse errors on one-line `if (...)` statements with multiple statements, e.g. `if (a) b() c() else d() e()` (issue [#78](https://github.com/japhib/pico8-ls/issues/78))
- Fix formatter breaking a one-line `if (...)` that contains a multi-line statement
- Show a helpful error instead of crashing when the "Format File" commands can't format a file with errors
- Warn about top-level `local` variables used before they're declared, e.g. in a function defined above the `local` (issue [#37](https://github.com/japhib/pico8-ls/issues/37))
- Fix Go to Definition, Find References and hover in a file that `#include`s other files sometimes picking a symbol from an included file, or showing duplicate definitions (issue [#61](https://github.com/japhib/pico8-ls/issues/61))

## 0.7.0 (9/14/2026)

- Syntax highlighting for all cartridge sections (`__lua__`, `__gfx__`, `__label__`, `__gff__`, `__map__`, `__sfx__`, `__music__`), plus the cartridge header lines
- Code folding for each cartridge section
- Fix formatter joining the line after a one-line `if (...)` onto it, when the `if` is nested inside another block (issue [#48](https://github.com/japhib/pico8-ls/issues/48))
- Fix formatter inlining the last statement of an `#include`-d file onto the `#include` line (issue [#85](https://github.com/japhib/pico8-ls/issues/85), PR [#89](https://github.com/japhib/pico8-ls/pull/89))

## 0.6.1 (9/23/2025)

- Fix for `#region` region markers (PR [#76](https://github.com/japhib/pico8-ls/pull/76)) -- thanks [@ryugibo](https://github.com/ryugibo)!
- Add new builtins `rrect` and `rrectfill`, and missing `load` (PR [#73](https://github.com/japhib/pico8-ls/pull/73)) -- thanks [@songbirdgamedev](https://github.com/songbirdgamedev)!
- Support for hexadecimal fractions like `0x.1` (issue [#74](https://github.com/japhib/pico8-ls/issues/74) -- thanks [@avi-0](https://github.com/avi-0) for reporting)

## 0.6.0 (9/10/2025)

- Add support for PICO-8 folding tabs `-->8` (PR [#72](https://github.com/japhib/pico8-ls/pull/72)) -- thanks [@ryugibo](https://github.com/ryugibo)!
- Add `__sfx__` and `__music__` to lexer (PR [#70](https://github.com/japhib/pico8-ls/pull/70)) -- thanks [@akd-io](https://github.com/akd-io)!
- Add builtin `tostring` function to docs (PR [#68](https://github.com/japhib/pico8-ls/pull/68)) -- thanks [@akd-io](https://github.com/akd-io)!

## 0.5.7 (11/08/2024)

- Fix formatter removing necessary parentheses (issue [#51](https://github.com/japhib/pico8-ls/issues/50), PR [#67](https://github.com/japhib/pico8-ls/pull/67))

## 0.5.6 (10/26/2024)

- Fix formatter adding a leading newline to .p8 files (issue [#51](https://github.com/japhib/pico8-ls/issues/51), PR [#65](https://github.com/japhib/pico8-ls/pull/65)) - thanks [@akd-io](https://github.com/akd-io)!

## 0.5.5 (10/18/2024)

- Fix autocomplete being broken for tables ([#62](https://github.com/japhib/pico8-ls/issues/62))

## 0.5.4 (7/14/2024)

- Add support for one-line `while` loop construct ([#11](https://github.com/japhib/pico8-ls/issues/11))
- Add support for new conditional syntax `if ... do ... end` ([#57](https://github.com/japhib/pico8-ls/issues/57))
- Fix changelog link ([#52](https://github.com/japhib/pico8-ls/pull/52))
- Moved a bunch of stuff to CI, making the release process a bit easier

## 0.5.3 (11/10/2023)

- Add support for code folding using `#region` comments ([#49](https://github.com/japhib/pico8-ls/pull/49)) - thanks [@TheCyberRonin](https://github.com/TheCyberRonin)!

## 0.5.2 (9/26/2023)

- Fix for auto-complete duplicating table name & access operator ([#40](https://github.com/japhib/pico8-ls/issues/40))
- Fix for auto-complete after table name showing _all_ auto-completions rather than just the ones for that table ([#25](https://github.com/japhib/pico8-ls/issues/25))
- Fix for snippets not working in `.lua` files ([#46](https://github.com/japhib/pico8-ls/pull/46) - thanks [@davidreif](https://github.com/davidreif)!)

## 0.5.1 (9/15/2023)

- Fixes formatting of single-line if statements with an `else` block
- Fixes formatting of `repeat ... until` loops ([#43](https://github.com/japhib/pico8-ls/issues/43))

## 0.5.0 (5/18/2023)

- Formatter has been released! Thanks to [@beetrootpaul](https://github.com/beetrootpaul) for major contributions in this feature.
- Closes [#26](https://github.com/japhib/pico8-ls/issues/26)
- Formatter is accessible through regular "Format Document" feature (Alt + Shift + F by default)
- Also accessible through Command Palette, with `PICO-8 LS: Format File - Each Statement on Separate Line` command. This version of the formatter will ensure that each statement is on a separate line, as opposed to the normal one which will keep statements on the same line.
- Works on both `.lua` and `.p8` files!

## 0.4.10 (12/22/2022)

- Add snippets for pico-8 glyphs ([#30](https://github.com/japhib/pico8-ls/issues/30)) - thanks to [@mika76](https://github.com/mika76) for the contribution!
- Fix for labels being marked undefined unless defined before goto ([#32](https://github.com/japhib/pico8-ls/issues/32))

## 0.4.9 (12/17/2022)

- Add `reset` and `info` built-in function calls ([#36](https://github.com/japhib/pico8-ls/pull/36)) - thanks to [@miguno](https://github.com/miguno) for the contribution!

## 0.4.8 (9/23/2022)

- Fixed snippets
- Added working indentation rules based on the other [pico8vscodeeditor](https://github.com/grumpydev/pico8vscodeeditor) extension

## 0.4.6 (7/27/2022)

- Fix file URI resolution for Windows (fixes go-to-definition and find-references) ([#20](https://github.com/japhib/pico8-ls/issues/20))
	- (0.4.7) Apply same fix in places that were missed before ([#22](https://github.com/japhib/pico8-ls/issues/22))

## 0.4.4 (6/15/2022)

- Support for binary literals like `0b0101101001011010.1` ([#10](https://github.com/japhib/pico8-ls/issues/10))
- (0.4.5) Added auto-complete demo in readme

## 0.4.3 (6/9/2022)

- Fix shorthand ? print function messing up document outline ([#17](https://github.com/japhib/pico8-ls/issues/17))

## 0.4.2 (6/6/2022)

- Fix warning on shorthand ? print function
- Fix warning on labels and gotos ([#16](https://github.com/japhib/pico8-ls/issues/16))
- Add support for `extcmd`, `yield`, and a few other missing built-in functions ([14](https://github.com/japhib/pico8-ls/issues/14))

## 0.4.1 (6/2/2022)

- Better support for `#include`ing files -- files included by other files now have the same global scope. Go to definition and find usages works both from the including file, and from the included file. (Previously only worked from the including file.) ([#3](https://github.com/japhib/pico8-ls/issues/3))
- Fix code folding ([#15](https://github.com/japhib/pico8-ls/issues/15))

## 0.4.0 (5/26/2022)

- Add support for `#include`ing files ([#3](https://github.com/japhib/pico8-ls/issues/3), [#8](https://github.com/japhib/pico8-ls/issues/8))
- Add support for built-in global symbols like ❎, 🅾️, and ░ ([#9](https://github.com/japhib/pico8-ls/issues/9))

## 0.3.3 (4/6/2022)

- Add support for [P8SCII](https://pico-8.fandom.com/wiki/P8SCII) control codes in string literals ([#7](https://github.com/japhib/pico8-ls/issues/7))
- Added built-in t() and time() functions ([#2](https://github.com/japhib/pico8-ls/issues/2))

## 0.3.2 (4/1/2022)

- Fixed plugin not working on Windows because of problem parsing CRLF line endings ([#5](https://github.com/japhib/pico8-ls/issues/5))

## 0.3.1 (2/22/2022)

- Removed one of the leading 0's from the versioning scheme
- Added `stat` with docs to the builtins ([#1](https://github.com/japhib/pico8-ls/issues/1))

## 0.0.3 (2/7/2022)

- Hover support for built-in functions
- Auto-completion
- Signature help
- Disabling warnings for unused locals until bugs are fixed
- Remove some warnings about Unicode characters left over from luaparse library

## 0.0.2 (1/31/2022)

- Started using esbuild for bundling extension (should improve install/load performance)
- Go to definition
- Find references
- Warnings for undefined globals, unused locals
- Snippets for commonly typed patterns (if, then, function)

## 0.0.1 (1/23/2022)

First release, very basic feature set:
- Syntax highlighting
- Syntax errors
- Go to symbol
