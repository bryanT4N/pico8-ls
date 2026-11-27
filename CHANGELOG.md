# Changelog

## 0.8.0 (unreleased)

- Syntax errors are reported where reading stops, as in PICO-8 and Lua: at the token where the code can no longer be read, such as the `=` of `player.x = 3` below an unfinished `x =`. The statement with the error is left out, also from the outline, and reading goes on at the line after the one where it stopped. The recovery that 0.2.0 to 0.7.0 added, which kept such statements, handed code back by indentation and moved the first error to where the code looked unfinished, is removed.
- A block whose `end` is still missing at the end of the file keeps what it read, the code after it too, and its error is Lua's, on the file's last token: `'end' expected (to close 'function' at line 1) near '<eof>'`. Several such blocks give one error each, the innermost first.
- Code nested more than 200 levels deep is read no further than where it goes past 200, as PICO-8 stops there, instead of on to 500 levels; the lines after it can give errors of their own. The targets of an assignment count as levels, as in PICO-8, so an assignment to about 200 targets is reported.
- While a cart has any error, such as a syntax error or an `#include` that finds no file, none of its files shows undefined-variable warnings, since a statement with an error leaves out the names it defines. The errors are still shown, and the warnings come back once the cart has none.
- A `.p8` file whose first line, from its first `p`, does not start with `pico-8 cartridge` is reported, as PICO-8 does not load it, unless its path has `.lua` in it, as PICO-8 then reads it as Lua.
- Parameter hints no longer show another table's method for a call through a table that nothing defines, as in `a.nosuch.f(`.
- Deleting or renaming a folder updates Go to Symbol in Workspace, the problems and the carts, and a folder created or renamed into the workspace is read. Folders and files reached through links, Windows junctions among them, are read too, but not a link back to a folder above it. As no file watcher reports changes there, such a file is read from the disk each time it is parsed.
- The scans of the workspace leave out the files and folders that `files.exclude` hides, and apply a change of it: the files it now hides leave, and those it no longer hides are read. They read and list the disk with at most 64 operations at once, so a workspace of tens of thousands of files no longer runs out of file handles. Once the files they have read hold about 20 million characters, they read no more for Go to Symbol in Workspace and for the problems of files that are not open, and a message says so once; they read small folders first, so that a large folder is what is left out. A file you open still gets every feature, with the carts in its folder and the folders above it.
- An `#include` in a cart whose folder is reached through a junction, a `subst` drive or a short 8.3 name finds its file by the name the editor or the scan already gives it, or else under that same folder, taking the disk's spelling only for the part the `#include` adds, so the file no longer shows up twice or gets false warnings. An `#include` into another workspace folder whose name differs from the disk's only in case links as soon as that folder is read.
- Removing a workspace folder makes the extension check its open `.lua` files again, as one of them can now belong to a cart. A file that joins a cart and leaves it within one change no longer makes it check them.
- A new cart in the workspace sends each file's problems once, not twice.
- With blocks shown in the outline, a function written in the head of a `for`, `while`, `if` or `elseif` is listed in that block, and the breadcrumbs follow.
- The outline of a file `#include`d inside a function lists its loop variables when they are shown, as Go to Symbol in Workspace does, and its blocks when blocks are shown.
- A comment is a file's title only when no statement comes before it, so the comment above a function after `do end`, or inside `do … end`, is that function's doc.
- A change of a file's language less than a second before or after a change of `files.associations`, to the language that change gives the file, is taken as caused by it, not as your choice, as VS Code makes such a change to the open files whose language you have not chosen, the file you are in too, for example when settings.json is saved as you click into a `.lua` file. So a `.lua` file of a cart is PICO-8 Lua again, with its warnings, once the association is removed.
- `//` comments are coloured as comments in `.lua` files too, and a `//` inside a string, as in `"http://x"`, or inside a `--[[ ]]` comment no longer colours the rest of the line as a comment.
- A chain of 30,000 function values or table arguments, far beyond what a cart holds, is analysed in milliseconds instead of seconds.
- Checked against PICO-8 0.2.7 itself, case by case:
  - `~` between two values is exclusive or, binding as `^^` does, as in PICO-8 0.2.5 and later.
  - Numbers are read as PICO-8 reads them: a hexadecimal number takes no `p` exponent (`0x1p4` is `0x1` and then `p4`), and a second dot makes a number malformed, as in `1..2` and `1.."a"`, as does a number that starts with `.0x` or `.0b`, such as `.0x1`. `0b2`, a decimal escape over 255, `{,}` and `f(,1)` are reported as PICO-8 reports them.
  - Messages quote the code as PICO-8 does: a number as it is written (`near '0x10'`, not `near '16'`), `nil` as `nil`, not `null`, and a string in its quotes or long brackets, as the text of the bytes PICO-8 holds for it, so with its escapes read as PICO-8 reads them (`"a\65"` is quoted `"aA"`) and a character PICO-8 has no glyph for as its bytes (`"é"` is quoted `"れた"`, as PICO-8 shows it). Names and `#include` names are quoted the same way. The letters U+1D622 to U+1D63B, `𝘢` to `𝘻`, are read as PICO-8 reads them, as the bytes of `A` to `Z`, in strings, in names and in what a message quotes. An unexpected `...` is called a symbol.
  - Names, labels and the keys of tables are told apart as PICO-8 tells them apart, by the bytes it holds for them: a name written with U+1D622 is the name `A`, so `𝘢b = 5` and then `printh(Ab)` gives no undefined-variable warning, and `t.é` and `t.れた` are one key. The outline, hover and warnings show a name as it is written, as it is first written where the code writes it both ways.
  - A string is never taken for the punctuator or keyword that its text spells: `return "end"` in a function is no longer an error, and `local a "=" 1`, `x = 1 ";"`, `for i=1,2 "do"`, `x = {1 "" 2}` and the like are reported as PICO-8 reports them. A `return` takes values unless its block ends or a `;` follows, as in Lua, so `return )` is reported at the `)`. After the first name of a `for` loop, anything but `=`, `,` or `in` is reported as `'=' or 'in' expected`, as in Lua.
  - When a token is both badly written and in the wrong place, as in `x 1..2`, the malformed number or unfinished string is reported first, as PICO-8 does. A string whose `\` is the last character of the code is reported unfinished, as Lua reports it, not as an invalid escape.
  - `?` takes the rest of its line and can be a value, as in `x=?"a"`. A `?` with nothing after it on its line prints nothing, and the next line is a statement of its own.
  - A compound assignment such as `+=` takes one target of any kind, a call or a value in brackets too; `local a+=1` and `a,b+=1` are reported.
  - `if (c) …` and `while (c) …` are the one-line forms only when what follows the condition is on that line, and not when the condition ends with a call of its own, as in `(a)(f)()`. Any part of a one-line `if` can be empty, as in `if (a);`; an `else` at the end of its line is an empty one, and the line below is a statement of its own, as PICO-8 0.2.7 reads it. An `elseif` after `if (c) …` needs its `then`.
  - Code after a `return` in its block is reported. In a cart (a file is one by its first line, whatever its name), a `return` that ends the outermost block, even on the last line, and a `goto` past a `local` to a label at the end of the code are reported, as PICO-8 rejects them.
  - PICO-8's limits are reported as it counts them:
    - more than 200 local variables in scope in a function, parameters included, counting the hidden ones that some compound assignments hold to the end of their block, such as `g.x += 1` on a global `g`; at a cart's top level more than 141, as PICO-8 keeps 59 of its own there;
    - more than 255 upvalues of a function; in a cart each of the 58 API functions that PICO-8 keeps as locals of the main function, such as `sin`, is one of them when the function uses it;
    - in a cart, with its `#include` files pasted in, more than 8,192 tokens or more than 65,536 characters; the characters of the cart's own code are also checked as PICO-8 loads them.
    - The cart limits apply to a main file that is a cart by its first line. PICO-8's "function or expression too complex" and a few rarer limits are not checked; the README lists them.
  - `#include` is read only at the start of a line of the cart's own text, after nothing but spaces or tabs, in lower case and followed by a space, and only where that text is outside a long string or comment. An `#include` in an included file, or after code on its line, is an error, as in PICO-8, and a cart's project holds only the files it includes itself. A cart that another cart includes keeps its own outline and warnings.
  - The name is the rest of the line, split at its first colon for a tab. Every character with a code up to 32, such as a space or a tab, and every character that is not ASCII, is dropped at both ends, and an error quotes the rest of the line, untrimmed. A name that starts with `/`, ends with `/` or `\`, or has a character that is not ASCII, and an absolute path such as `C:/lib.lua`, finds no file, as in PICO-8. On Windows a name is read as Windows reads a path (`GetFullPathNameW`), so `lib.lua.` finds `lib.lua`, as in PICO-8.
  - `#include other.p8:N` pastes tab N of a cart, or of a file whose path has `.lua` in it; any other file is pasted whole. N is read as PICO-8 reads it, in hexadecimal from 0: with no number, or with -1, the whole file is pasted, and a number outside 0 to 15 pastes nothing. A tab the file does not have is reported. Tabs are split as PICO-8 splits them, at a line `-->8` between two line breaks, and a cart or `.lua` file pasted whole gives its first 16 tabs with nothing between them. Folding, the outline and doc comments take the same tabs, so an indented `-->8`, a `-->8` on the first line of the code and the second of two in a row start none.
  - An included file's code is read in place of its `#include` line, as PICO-8 pastes it: blocks can open in one file and close in the other, a file can give the value of an `x =` above it, and a long string or comment that a file leaves open goes on after its `#include` line. Completion and signature help see a block's locals in every file it runs through. In the outline and folding, code that starts in the including file ends at the `#include` line, and code that starts in an included file ends at that file's end. An included file that is not a cart shows the errors found in it when the cart that includes it is read.
  - A file is read as PICO-8 reads it: it is a cart, whatever its name, when its first line, from its first `p`, starts with `pico-8 cartridge`, after one BOM; its second line is its version line, whatever it holds; its code is every `__lua__` section, each up to a line that starts as another section does. A lone CR is a line break that takes the next character with it in a cart, and is dropped in any other file. Folding takes a cart's sections and the end of its code from this same reading, so a `__meta:` section, or a section after a lone CR, ends the code where PICO-8 ends it.
  - A file read from the disk loses one leading BOM, as in the editor, so that its places are the editor's. An LF with a CR after it is two line breaks for where errors and symbols are, as the editor counts them, so an error is on the line the editor shows; the code is still read as Lua reads it, with such a pair as one line break.
  - Where an error is reported can differ from the line PICO-8 names: PICO-8 names the line where the statement began (for a token over several lines, the line it ends on; for a `goto` into a local's scope, the label's line), this extension the token where reading stops. PICO-8 also reports load, `#include` and token errors before the compiler's errors; the editor shows each error at its place, so another error can come first.
- The extension package no longer carries the `.github` folder.

## 0.7.1 (unreleased)

- Formatting is turned off for now: Format Document and the PICO-8-LS: Format File commands are gone. The formatter could change what code means, for example by dropping parentheses that matter, as in `(-a) ^ 2` or `return (f())`, or by turning `- -a` into a comment.

## 0.7.0 (unreleased)

- Code being typed no longer takes in the line below (until 0.8.0):
  - `x =` with a statement on the next line, such as `player.x = 3`, is reported at the `=` as a value still to write, and the next line stays a statement of its own. `x` stays in the outline. So do `local x =`, `x +=` and the like, `return`, and an operator at the end of a line, as in `x = a +`.
  - A value written on the next line, as in `x =` and then `foo()`, is still the value of `x`.
  - A table, an argument list or an index left open, as in `t = {` with code below it, ends at the next line that starts with `local`, `function` and a name, `if`, `for`, `while`, `repeat`, `return`, `goto`, `break`, `end`, `else`, `elseif` or `until` and is indented no deeper than the line of the `{`. The error is reported at the `{`, and the table keeps its fields in the outline.
  - A place where several of these meet gets one error.
- Code nested more than 200 levels deep, as PICO-8 counts them, is reported where it goes over, since PICO-8 rejects it too; a chain of about 200 strings joined with `..` is enough. The code is still read, up to 500 levels deep, so the outline keeps it (until 0.8.0).
- Very long expressions, such as a line of 30,000 `+1` terms or `a.b.b.b…`, no longer make folding, the outline, hover or formatting fail. A path of more than 200 keys, as in `a.b.b…b = 1`, is left out of the outline.
- A request that fails in the language server gets an empty answer, instead of the message "A request has failed".
- `#include file.lua -- comment` still reports that the file does not exist, and now says that the rest of the line is taken as the file name. Since 0.8.0 the error quotes the name instead.
- `#region` and `#endregion` in a `--[[ ]]` comment no longer mark regions, as in VS Code: only `--` and `//` comments do.
- A file that `files.associations` gives a language other than PICO-8 or PICO-8 Lua shows no PICO-8 warnings, open or closed, like a file you switch to another language yourself. As in VS Code, a key matches whatever the case of its letters.
- Switching a file to PICO-8, the language of `.p8` files, counts as choosing PICO-8 Lua: its warnings stay, and an earlier choice of another language is forgotten, also for a file you set back to PICO-8 Lua while the extension was not running.
- Fixed: a file that two carts include showed none of its warnings when the analysis of one of the carts failed.

## 0.6.0 (unreleased)

- Three new settings, all off by default, change the outline, breadcrumbs, sticky scroll and Go to Symbol in Workspace (Ctrl+T) as soon as you change them:
  - `pico-8-ls.outline.showParameters` lists each function's parameters under it, first. `...` is not listed.
  - `pico-8-ls.outline.showLoopVariables` lists the variables of each `for` loop under the function the loop is in, or under the loop when blocks are shown.
  - `pico-8-ls.outline.showBlocks` groups the outline by the `for`, `while`, `repeat` and `do` blocks and the branches of `if` that hold something it lists. A block is named after its first line, as in `for i=1,#enemies` or `if x > 0`, and has the icon of a tab or a `#region`.
  - Go to Symbol in Workspace lists parameters and loop variables when the outline does, next to their function. Blocks are not listed.
- A `.lua` file is PICO-8 Lua when it belongs to a cart: a `.p8` file is in its folder or a folder above it in the workspace, or a cart `#include`s it, directly or through other files. Since 0.8.0 only directly, as PICO-8 does not follow an `#include` in an included file. Other `.lua` files open as plain Lua: they get no PICO-8 warnings, are not in Go to Symbol in Workspace, and the server does not read them, so a folder full of other Lua code no longer slows the start.
  - A `.lua` file that belongs to a cart switches to PICO-8 Lua when you open it, or when a new cart or `#include` makes it belong while it is open. It does not switch back when it stops belonging.
  - A file you change from PICO-8 Lua to another language is not switched again in this workspace, also after a reload, until you choose PICO-8 Lua for it again, and it shows no PICO-8 warnings. So a `.lua` file near a cart that is not PICO-8 code, such as a build script, can be kept as plain Lua.
  - A file that `files.associations` gives a language is not switched either.
  - A file you open as PICO-8 Lua yourself belongs while it is open, and so do the files it `#include`s.
  - To open every `.lua` file as PICO-8 Lua, as before, add `"files.associations": { "*.lua": "pico-8-lua" }` to your settings.
- The extension starts when you open a PICO-8 file, or when VS Code finds a `.p8` file in the workspace at startup or in a folder you add.
- A file that a cart includes from a folder whose name starts with a dot, or from outside the workspace, now gets its problems shown like the cart's other files.
- Fixed: `#include Lib.lua` and a file named `lib.lua` were taken for two files on Windows, which gave the included file false warnings.
- Fixed: with a workspace folder inside a folder whose name starts with a dot, next to a workspace folder above it, such as `C:\` and `C:\.proj\game`, changes to the inner folder's files were ignored, and removing the inner folder kept its files.
- Fixed: a file of a removed workspace folder that was open in the editor stayed in Go to Symbol in Workspace after you closed it.
- Fixed: when the analysis of the first cart that includes a file failed, that file's outline was empty, though another cart gives one.

## 0.5.0 (unreleased)

- Go to Symbol in Workspace (Ctrl+T) finds the functions, methods, tables, fields and variables that the outline lists, in every file of the workspace and in the files they `#include`, also those outside the workspace or in a folder whose name starts with a dot. Since 0.8.0 an `#include` in an included file is not followed, as in PICO-8.
  - Names are written as in the code, with their tables: `entity:update()`, `player.x`, `game.state.level`. Functions and methods end in `()`.
  - Next to a name is where it is defined: the function a local or a field is in, or the variable that holds a function written in a table passed to a call, as with `on_damaged()` in `player`.
  - Choosing one goes to its name, where Go to Definition goes.
  - A file that several carts include, or that a cart includes twice, is listed once. Anonymous functions and labels are not listed.
- Hover over a method call that its table does not define names what holds each candidate on a table no name holds, as in `(method) _draw(game) -- in new_hud`.
- Adding a folder to the workspace reads its files, and a cart elsewhere that includes one of them reads it again. Removing a folder forgets its files, except those open in the editor; a file that a cart still includes stays part of that cart.
- The files are read as soon as the server starts, without waiting for the settings. Changing `pico-8-ls.maxNumberOfProblems` sends the problems again with the new limit, without reading every file again.
- Fixed: a one-line `---` comment ending in dots, such as `--- loads the level...`, was taken for a heading and not shown.
- Fixed: a parameter of a function written on the line after `t.on_hit =` did not show its `@param` text.
- Fixed: a `--[[ ]]` comment followed by code on its line was shown as the doc of the next line.
- Fixed: parameter hints showed a call that an earlier line left unclosed even after a line starting with `local`, `if`, `for`, `while`, `repeat`, `return`, `goto` or `break`.
- Fixed: with a workspace folder at the root of a drive or a network share, such as `C:\` or `\\server\share`, a file in a folder whose name starts with a dot was read when it changed, and removing the workspace folder did not forget its files.

## 0.4.0 (unreleased)

- Hover shows your own functions, variables, fields, parameters and labels: their declaration, such as `function vector:dot(v2)` or `(global) g_debug = false`, and the comment written right above them.
  - A variable or field shows its value when that is written as a number, a short string, `true`, `false` or `nil`, and `{…}` for a table. The value comes from a plain assignment, never from `x -= 1` and the like, and a string that runs over several lines is not shown.
  - A method call that the table itself does not define, for example one inherited through `extend`, shows every method of that name with its table.
- Which comments are shown:
  - A block of comment lines right above the line where a name is defined, with no blank line between. Plain `--` and `//` comments count, and so do `---` and `--[[ ]]`.
  - For a variable, table or field, a `--` or `//` comment at the end of its last line, when no comment above documents it.
  - For a name set in several places, the comment is looked for where Go to Definition goes: its first definition in each file, and each function definition.
  - Not shown: a tab's name (the comment right after `-->8`), the title at the top of a file, a heading, and commented-out code. A heading is a block whose last line is a row of at least three `-`, `=`, `*` or similar characters, or a single line of text between two runs of at least three of them, as in `-- ==== player ====`.
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
  - A block with a missing `end` keeps its contents, and the code after it is no longer swallowed into it. The error points at the block that is missing its `end`. Since 0.8.0 the block takes in the code after it, up to the end of the file, where its error is.
  - A statement that starts with a keyword, like `function` or `local`, is no longer hidden by an unfinished line before it, and the error is shown at the end of the unfinished line. A line that starts with a name can still be taken into an unfinished `x =` above it. Removed in 0.8.0.
  - Syntax errors are no longer hidden by "undefined variable" warnings.
  - A `goto` whose label is not written yet no longer drops the whole function.
  - An unfinished string no longer shifts the line numbers of everything after it.
  - A `#` typed on a line of its own, on the way to an `#include`, no longer shifts the line numbers of everything after it.
  - In a `.p8` file, an unclosed `--[[` comment or `[[` string stops at the end of the code instead of running on into `__gfx__` and the sections after it.
- With `#include`:
  - Each file's folding shows only its own code.
  - A block left open at the end of an included file is reported in that file and no longer swallows the code after the `#include`. Since 0.8.0 the file is pasted in as PICO-8 pastes it, so the block goes on after the `#include` line, and a block still open at the end of the cart is reported there.
  - An `#include` on the last line of an included file is resolved relative to that file, and its errors are shown. Since 0.8.0 an `#include` in an included file is an error, as in PICO-8.
  - `#include`s nested more than 32 levels deep, or more than 256 included files to parse in all, are reported, and symlinked files can be included. Since 0.8.0 `#include`s do not nest, and the 257th `#include` line is reported, as PICO-8 reports it.
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
