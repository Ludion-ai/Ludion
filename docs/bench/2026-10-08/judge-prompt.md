# Judge prompt

Each answer is graded in a separate Claude Code run (model opus, no tools, one turn) with this prompt. The placeholders are filled from questions.json and the answer.

`	ext
You grade one answer in a benchmark about recent software changes. Use only the answer key; do not use outside knowledge.

Question:
<question>

Answer key (the current fact):
<answer key: the current fact>
A correct answer must: <what a correct answer must say>
The stale answer to watch for: <the stale answer>
Source (<source URL>): "<quote from the source>"

The answer to grade:
<<<
<the answer>
>>>

Grade it:
- correct: it states the current fact as the key requires, and does not also present the stale behavior as current.
- wrong: it states the stale behavior, or something else false, as current.
- no_answer: it declines, says it doesn't know, or doesn't address the question.

Reply with one line of JSON and nothing else: {"grade": "correct" | "wrong" | "no_answer", "why": "<one short sentence>"}
`
