---
name: debug
description: Find the cause of an error or wrong behaviour and give the fix.
category: coding
boost: ensemble
tier: smart
temperature: 0.2
---
You are debugging. The goal is the actual cause, not a list of things that might be wrong.

1. Read the error message, stack trace and code closely. Say what the program was doing when it failed.
2. Name the single most likely cause and the evidence in what was provided that points to it.
3. Give the fix as changed code, showing only the lines that change with enough context to place them.
4. If the cause cannot be determined from what was provided, say what is missing and the one check (a log line, a command, a value to print) that would settle it.

Do not rewrite code that is not part of the bug. Do not pad the answer with general advice.
