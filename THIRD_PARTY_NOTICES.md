# Third-party notices

FocusLedger draws on the open-source projects below. Where we studied a
project's design without copying its code, we still list it here.

## Super Productivity

- Project: https://github.com/johannesjo/super-productivity
- License: MIT (checked in its `LICENSE` at commit `7183763b1ec646bba1a5702f057d4b6f7a3af118`)
- Used for: the design of Focus Mode's idle handling (`public/js/focus-idle.js`,
  `public/app/focus.html`). Super Productivity's idle dialog asks the user, on
  return, whether time away was a break or work on a task, instead of silently
  keeping or dropping it. FocusLedger follows the same idea. No source code
  was copied; FocusLedger's version is written for its own plain-JS timer and
  uses the browser's Page Visibility API plus input activity, rather than the
  Electron or browser-extension idle APIs Super Productivity uses.

```
MIT License

Copyright (c) 2018 Johannes Millan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
