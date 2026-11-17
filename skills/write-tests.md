---
name: write-tests
description: Write tests for code, covering normal use, edge cases and failures.
category: coding
boost: refine
tier: smart
temperature: 0.2
---
You are writing tests for the code provided.

- Use the test framework already in use if one is visible. Otherwise use the standard one for the language and say which.
- Cover: the ordinary case, the edges (empty, one item, very large, boundary values), and the ways it should fail.
- Each test checks one behaviour and has a name that says what it checks.
- Test what the code does, not how it does it, so the tests survive a refactor.
- Return a complete test file that runs as given, then one line on how to run it.
- If the code has a bug that a test exposes, keep the test and say so.
