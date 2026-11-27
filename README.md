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
- Support for `#include`ing other files. As in PICO-8, a file's code is read in place of its `#include` line, so a block can open in one file and close in the other, a file can give the value of an `x =` above it, and a long string or comment that a file leaves open goes on after its `#include` line. An included file, unless it is a cart, shows the errors that the code including it has in it with the file read in. Completion and signature help take code that runs from one file into another to end at the `#include` line, or at the end of the included file it starts in.
- Snippets for common idioms (functions, loops, etc) as well as pico-8 symbols (`p8-jelpi` -> 🐱, `p8-x-key` -> ❎, etc)

## Which `.lua` files are PICO-8 Lua

A `.lua` file opens as PICO-8 Lua when it belongs to a cart:

- a `.p8` file is in its folder, or in a folder above it inside the workspace folder (a folder whose name starts with a dot does not count; folders reached through links, such as Windows junctions, do), or
- a cart in the workspace (outside folders whose names start with a dot), a `.lua` file there that the rule above counts, or any file you have open as PICO-8 or PICO-8 Lua `#include`s it directly, wherever it is. As in PICO-8, an `#include` in an included file is not followed, unless that file is a cart of this list, which PICO-8 runs on its own. When files of this list include one another and no other `#include` that is followed reaches them, each of them counts as not included.

Only `#include` in lower case and followed by a space, with nothing but spaces or tabs before it on its line, is an `#include`.

Other `.lua` files open as plain Lua, and the language server leaves them alone. A file you switch to PICO-8 Lua yourself, with Change Language Mode, is PICO-8 Lua while it is open.

When you switch a file from PICO-8 Lua to a language other than PICO-8, the extension does not switch it back to PICO-8 Lua in this workspace, also after a reload, until you choose PICO-8 Lua for it again. So a `.lua` file near a cart that is not PICO-8 code, such as a build script, can be kept as plain Lua, and it then shows no PICO-8 warnings. Nor does the extension switch a file that `files.associations` gives a language; when that language is not PICO-8 or PICO-8 Lua, the file shows no PICO-8 warnings either, open or closed.

A change of `files.associations` also sets the open files whose language you have not chosen yourself back to the language it gives them, the file you are in too, for example when settings.json is saved as you click into a `.lua` file. So a change of language less than a second before or after a change of `files.associations`, to the language it gives the file, is taken as caused by it, not as your choice.

The extension starts when you open a PICO-8 file, or when VS Code finds a `.p8` file in the workspace at startup or in a folder you add.

To open every `.lua` file as PICO-8 Lua, as versions before 0.6.0 did, add this to your settings:

```json
"files.associations": { "*.lua": "pico-8-lua" }
```

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
