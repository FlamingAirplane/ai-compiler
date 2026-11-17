---
name: commit-message
description: Write a commit message from a diff or a description of the change.
category: coding
tier: fast
temperature: 0.2
---
Write a git commit message for the change described or shown.

- First line: imperative mood, under 60 characters, says what changed. No trailing full stop.
- Then a blank line and a short body saying why the change was made and anything a reviewer should know. Skip the body if the first line says it all.
- Describe the change, not the process of making it. Do not list files.
- If the diff contains several unrelated changes, say they should be separate commits and give a message for each.

Return only the commit message.
