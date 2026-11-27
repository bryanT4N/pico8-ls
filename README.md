# PICO-8-LS

A personal fork of [PICO-8 LS](https://github.com/japhib/pico8-ls) by JanPaul Bergeson. It keeps the original features and changes how the outline is built: it lists definitions instead of every assignment, groups table members under their table, and leaves out function parameters, loop variables and blocks unless you turn them on in the settings (`pico-8-ls.outline.*`). See [CHANGELOG.md](CHANGELOG.md) for details.

Full language support for the [PICO-8](https://www.lexaloffle.com/pico-8.php)
dialect of Lua. 

The goal is to have all the features you'd expect in a full-fledged language
server, such as [the one for Lua](https://marketplace.visualstudio.com/items?itemName=sumneko.lua),
but specifically tailored for a frictionless PICO-8 experience.

## Feature highlights

View docs on hover, then auto-complete and signature help:

![docs gif](https://github.com/japhib/pico8-ls/blob/master/img/docs.gif?raw=true)

Full support for `#include` statements:

![include gif](https://github.com/japhib/pico8-ls/blob/master/img/includes.gif?raw=true)

## Features

- Syntax highlighting (including all cartridge sections: `__lua__`, `__gfx__`, `__label__`, `__gff__`, `__map__`, `__sfx__`, `__music__`)
- Code folding (functions, blocks, `-->8` tabs, `#region` markers, and cartridge sections); code that runs from one file into another through an `#include` folds up to the `#include` line, or to the end of the included file it starts in
- Syntax errors
- Warnings on undefined variable usage
- Find symbol in document, with options to list parameters and loop variables and to group by `for` and `if` blocks; code that runs from one file into another through an `#include` ends there at the `#include` line, or at the end of the included file it starts in
- Find symbol in workspace (Ctrl+T), also in `#include`d files outside it
- Go to definition
- Find references
- Hover support & signature help for built-in functions
- Hover for your own functions, variables, fields, parameters and labels: their declaration and the comment written above them
- Signature help for your own functions, with their comment and each parameter's `@param` text
- Auto-completion
- Support for `#include`ing other files. As in PICO-8, a file's code is read in place of its `#include` line, so a block can open in one file and close in the other, a file can give the value of an `x =` above it, and a long string or comment that a file leaves open goes on after its `#include` line. An included file, unless it is a cart, shows the errors that the code including it has in it with the file read in. For completion and signature help, a block whose code runs from one file into another holds its locals in every file it runs through, whichever file it starts in.
  - The name is the rest of the line, as in PICO-8: the characters with codes up to 32, such as spaces and tabs, and those that are not ASCII are dropped from both ends, and an error quotes the rest of the line. As in PICO-8, a name that starts with `/`, ends with `/` or `\`, or has a character that is not ASCII finds no file, and on Windows a name is read as Windows reads a path.
  - `#include other.p8:N` pastes tab N, counted from 0 in hexadecimal, of a cart or of a file whose path has `.lua` in it. With no number the whole file is pasted, a cart or such a file as its first 16 tabs with nothing between them.
- Snippets for common idioms (functions, loops, etc) as well as pico-8 symbols (`p8-jelpi` -> 🐱, `p8-x-key` -> ❎, etc)

## Errors

The first syntax error is at the token where PICO-8 stops reading the code; PICO-8 names the line where that statement began (for a token over several lines, the line it ends on; for a `goto` into a local's scope, the label's line), so the lines can differ. A statement with an error is left out of the outline, and while a cart has an error, none of its files shows undefined-variable warnings.

PICO-8 0.2.7's limits are checked as PICO-8 counts them: more than 200 local variables in scope in a function, or 141 at a cart's top level, where PICO-8 keeps 59 of its own, counting the hidden ones that some compound assignments hold, such as `g.x += 1` on a global `g`; more than 255 upvalues of a function, in a cart each of the 58 API functions that PICO-8 keeps as locals of its main function, such as `sin`, counting as one when the function uses it; nesting deeper than 200 levels; and in a cart, with its `#include` files pasted in, more than 8,192 tokens or 65,536 characters. The cart limits apply to a main file that is a cart by its first line, `pico-8 cartridge`. A `.p8` file whose first line, from its first `p`, does not start with `pico-8 cartridge` is reported, as PICO-8 does not load it, unless its path has `.lua` in it.

Not checked:

- PICO-8's "function or expression too complex", too many registers in use, as with more than 189 arguments in one call at a cart's top level, or 248 in a function.
- The size of the code in bytes: code made mostly of glyphs passes about 196,600 bytes before 65,536 characters, and PICO-8 then crashes or gives a false error.
- The hidden local that PICO-8 also takes for a compound assignment once a function holds about 256 constants, which a cart's top level reaches from about its 68th compound assignment.
- The hidden local of a compound assignment whose key is literals joined by an operator that PICO-8 does not fold, as in `t[~1] += 1`.
- PICO-8's buffer of about 65,533 characters for an `#include`d file ("#include file too long"); the character limit is reported instead.
- The character counts of code that has a U+FFFD, and the count with `#include` files when an included file that is neither a cart nor a `.lua` file has a `-->8` line, when a cart or `.lua` file included whole has more than 16 tabs, or when an `#include` names a tab outside 0 to 15.
- A cart's limits, and the `return` and `goto` that PICO-8 rejects at the end of a cart's outermost block, for a main file without the cart header: a `.lua` file, often a library that a cart includes, or a `.p8` file whose path has `.lua` in it, which PICO-8 runs as Lua.

PICO-8 reports loading, `#include` and token errors before the compiler's errors; the editor shows each error at its place, so another error can come first.

## Which `.lua` files are PICO-8 Lua

A `.lua` file opens as PICO-8 Lua when it belongs to a `.p8` file:

- a `.p8` file is in its folder, or in a folder above it inside the workspace folder (a folder whose name starts with a dot does not count; folders reached through links, such as Windows junctions, do), or
- a `.p8` file in the workspace (outside folders whose names start with a dot), a `.lua` file there that the rule above counts, or any file you have open as PICO-8 or PICO-8 Lua `#include`s it directly, wherever it is. As in PICO-8, an `#include` in an included file is not followed, unless that file is a `.p8` file of this list, as PICO-8 runs a cart on its own. When files of this list include one another and no other `#include` that is followed reaches them, each of them counts as not included.

Only `#include` in lower case and followed by a space, with nothing but spaces or tabs before it on its line, is an `#include`, and, as in PICO-8, only where the including file's own text is outside a long string or comment: one that an included file leaves open does not count.

Other `.lua` files open as plain Lua, and the language server leaves them alone. A file you switch to PICO-8 Lua yourself, with Change Language Mode, is PICO-8 Lua while it is open.

When you switch a file from PICO-8 Lua to a language other than PICO-8, the extension does not switch it back to PICO-8 Lua in this workspace, also after a reload, until you choose PICO-8 Lua for it again. So a `.lua` file near a `.p8` file that is not PICO-8 code, such as a build script, can be kept as plain Lua, and it then shows no PICO-8 warnings. Nor does the extension switch a file that `files.associations` gives a language; when that language is not PICO-8 or PICO-8 Lua, the file shows no PICO-8 warnings either, open or closed.

A change of `files.associations` also sets the open files whose language you have not chosen yourself back to the language it gives them, the file you are in too, for example when settings.json is saved as you click into a `.lua` file. So a change of language less than a second before or after a change of `files.associations`, to the language it gives the file, is taken as caused by it, not as your choice.

The extension starts when you open a PICO-8 file, or when VS Code finds a `.p8` file in the workspace at startup or in a folder you add.

To open every `.lua` file as PICO-8 Lua, as versions before 0.6.0 did, add this to your settings:

```json
"files.associations": { "*.lua": "pico-8-lua" }
```

## Large workspaces

The language server reads the `.p8` files of the workspace and the `.lua` files that belong to them, leaving out what `files.exclude` hides, also after you change it. It reads small folders first, and a folder's files all or none, and once the files it has read hold about 20 million characters it keeps no more and says so once, so that a large folder is what is left out: Go to Symbol in Workspace and the problems of files that are not open then leave out the rest. Of those it reads only the `#include` lines, and a `.lua` file that one of them includes shows no undefined-variable warnings, as that file can define the names it uses. A file you open still gets every feature, with the `.p8` files in its folder and the folders above it, which it then reads in full; only undefined-variable warnings can still be left out, as above. To have everything read, exclude the large folders you do not work on, such as generated or test output, with `files.exclude`.

## Support for other platforms

This extension uses the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/),
so while it's mainly made for VSCode, it could also be used for other editors
such as NeoVim, Atom, etc.

I don't have any experience setting up language extensions for platforms other than VSCode, so currently
looking for help with that. See tips and support thread on the issue for various editors:
- [Neovim](https://github.com/japhib/pico8-ls/issues/34)
- [Sublime Text](https://github.com/japhib/pico8-ls/issues/44)

## Changelog

[Changelog has been moved to a separate file.](CHANGELOG.md)

## Development

Please follow the official [Language Server Extension Guide](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide)
to understand how to develop VS Code language server extension.

## Credits

PICO-8 Lua parser based on https://github.com/fstirlitz/luaparse (heavily updated & ported to Typescript by @japhib)

[PICO-8](https://www.lexaloffle.com/pico-8.php) by Lexaloffle Games
