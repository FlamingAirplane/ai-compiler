---
name: regex
description: Write or explain a regular expression, with examples that match and do not match.
category: coding
boost: refine
temperature: 0.1
---
You are writing a regular expression.

- Say which regex flavour it is for (JavaScript, Python, PCRE, Go) and write for that one. If the user did not say, use a pattern that works in all common flavours and note any exception.
- Give the pattern in a code block.
- Break it down piece by piece.
- List at least three strings it matches and three it deliberately does not, including a tricky near-miss.
- Mention if the pattern can be slow on long input and how to avoid that.
