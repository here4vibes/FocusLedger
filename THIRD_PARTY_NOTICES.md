# Third-party notices

FocusLedger includes material from the third-party projects below. Packages
installed through npm carry their own licenses in `node_modules`; this file
covers code and assets copied into the repository itself.

## Lucide

- **What:** SVG path data for the navigation icons, copied into
  `public/js/icons.js` (house, square-check-big, wallet, heart, mail, users,
  settings, circle-help, log-out, x, plus, message-circle).
- **Source:** https://lucide.dev, npm package `lucide-static` 0.460.0
- **License:** ISC

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## anthropics/skills (Apache License 2.0)

Upstream: https://github.com/anthropics/skills, commit `dbd4588f9e1033efb41dad4bef2f7947c8993d44`. Copyright 2026 Anthropic, PBC.

| FocusLedger file | Upstream path | Changes |
|---|---|---|
| `.claude/skills/webapp-testing/SKILL.md` | `skills/webapp-testing/SKILL.md` | Rewritten from Python to Node Playwright around CLAUDE.md "Local browser testing"; `scripts/with_server.py` and `examples/` not copied. |
| `.claude/skills/helper-authoring/SKILL.md` | `skills/skill-creator/SKILL.md` | Condensed to the skill-writing guidance; eval tooling not copied; FocusLedger import and attribution rules added. |

The full license text is in `LICENSE.txt` beside each of those files. Licensed under the Apache License, Version 2.0; you may not use these files except in compliance with the License. You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0. Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

## anthropics/claude-cookbooks (MIT License)

Upstream: https://github.com/anthropics/claude-cookbooks, commit `a162e0184e71b60290808a43961a6cbc8060123c`.

| FocusLedger file | Upstream material | Changes |
|---|---|---|
| `.claude/skills/buddy-tool-use/SKILL.md` | `tool_use/customer_service_agent.ipynb`, `tool_use/parallel_tools.ipynb`, `tool_use/tool_choice.ipynb`, `tool_use/extracting_structured_json.ipynb`, `patterns/agents/` | Patterns distilled and rewritten for `lib/agent-tools.js`, `routes/agent.js` and `lib/claude-client.js`; no notebook code copied. |

```
MIT License

Copyright (c) 2023 Anthropic

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

## affaan-m/everything-claude-code (MIT License)

Upstream: https://github.com/affaan-m/everything-claude-code, commit `b92f181`. Adapted in `.claude/agents/silent-failure-hunter.md`, `.claude/agents/database-reviewer.md`, `.claude/agents/security-reviewer.md` and `.claude/skills/postgres-patterns/SKILL.md` (which also credit Supabase's MIT-licensed postgres best practices); see each file's header comment.
