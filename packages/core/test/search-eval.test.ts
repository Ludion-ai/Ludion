// Search quality: what ludion_ask returns for questions people actually ask, over the sample lessons
// (apps/site/samples) and the real ones (lessons/). Off-topic questions must find nothing (ludion_ask then answers
// with its no-match text); on-topic questions must find the right lesson in the top 3, at least 90% of the time.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndex, search, validateLesson, type Lesson } from "../src/index.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function readLessons(dir: string): Lesson[] {
  const out: Lesson[] = [];
  for (const subject of readdirSync(dir, { withFileTypes: true })) {
    if (!subject.isDirectory()) continue;
    for (const file of readdirSync(join(dir, subject.name))) {
      const v = validateLesson(JSON.parse(readFileSync(join(dir, subject.name, file), "utf8")));
      if (!v.ok) throw new Error(`${file} is not a valid lesson`);
      out.push(v.lesson);
    }
  }
  return out;
}

const lessons = [...readLessons(join(root, "apps/site/samples/lessons")), ...readLessons(join(root, "lessons"))];
const index = buildIndex(lessons, {}, new Map(), { org: "Ludion-ai", repo: "ludion" });

/** Questions unrelated to every lesson: cooking, geography, sport, and technology the lessons don't cover. */
const OFF_TOPIC = [
  "What is the capital of France?",
  "How do I use docker?",
  "How do I make sourdough bread rise faster?",
  "What's a good recipe for chicken curry?",
  "How tall is Mount Everest?",
  "Who won the World Cup in 2018?",
  "How do I center a div with flexbox?",
  "How do I configure nginx as a reverse proxy?",
  "What is the best way to learn Kubernetes?",
  "How long should I boil an egg?",
  "What's the population of Tokyo?",
  "How do I write a for loop in Go?",
  "Explain quantum entanglement simply",
  "How do I set up a PostgreSQL replica?",
  "How do I deploy a React app to Vercel?",
];

/** Two ways a person might ask about each active lesson, never the claim's own wording. Keyed by a phrase of the claim. */
const ON_TOPIC: Record<string, [string, string]> = {
  "removed cgi": ["Is the cgi module still in Python 3.13?", "cgi import fails after upgrading to Python 3.13"],
  "global WebSocket client": ["Does Node 22 have a built-in WebSocket?", "Do I still need the ws package for websockets in Node.js?"],
  "rfl proves it": ["How do I prove n + 0 = n in Lean 4?", "Why does rfl prove adding zero to a natural number in Lean?"],
  "git switch and git restore": ["What's the difference between git switch and git checkout?", "How do I restore a file with git restore?"],
  "tsc --init does not choose it": ["Does tsc --init enable moduleResolution bundler?", "What is moduleResolution bundler in TypeScript 5?"],
  "period of 10 or 60 seconds": ["What periods can a Cloudflare Workers rate limiting binding use?", "Can a Workers rate limit binding use a 30 second window?"],
  "sort -V puts version 1.10": ["How do I sort version numbers correctly with sort?", "Why does sort put 1.10 before 1.9?"],
  "unsafe extern": ["Do extern blocks need unsafe in Rust 2024?", "Rust 2024 edition extern block error"],
  "dict keeps insertion order": ["Are Python dicts ordered?", "Does dict preserve insertion order in Python 3.7?"],
  "CSS :has() selector": ["Can I use the :has() selector in all browsers?", "Is CSS :has supported in Firefox?"],
  "RETURNING on INSERT": ["Does SQLite support RETURNING?", "How do I return a row from an INSERT in SQLite?"],
  "removed the distutils module": ["What changed about distutils in Python 3.12?", "distutils import error on Python 3.12"],
};

describe("search quality", () => {
  it("covers every active lesson with two on-topic questions", () => {
    const covered = index.lessons.filter((l) => Object.keys(ON_TOPIC).some((key) => l.claim.includes(key)));
    expect(covered.map((l) => l.id).sort()).toEqual(index.lessons.map((l) => l.id).sort());
  });

  it("finds nothing for off-topic questions, and the right lesson in the top 3 for on-topic ones", () => {
    const offHits = OFF_TOPIC.map((q) => ({ q, got: search(index, q).map((l) => l.claim.slice(0, 50)) })).filter((r) => r.got.length > 0);

    const onResults = Object.entries(ON_TOPIC).flatMap(([key, questions]) => {
      const want = index.lessons.find((l) => l.claim.includes(key))!;
      return questions.map((q) => {
        const got = search(index, q, { k: 3 });
        return { q, ok: got.some((l) => l.id === want.id), got: got.map((l) => l.claim.slice(0, 40)) };
      });
    });
    const onHits = onResults.filter((r) => r.ok).length;
    const onRate = onHits / onResults.length;

    // Written straight to stdout so the numbers show in every run, passing or not.
    process.stdout.write(
      [
        `Search quality over ${index.lessons.length} lessons:`,
        `  off-topic: ${OFF_TOPIC.length - offHits.length}/${OFF_TOPIC.length} found nothing (needs all)`,
        ...offHits.map((r) => `    returned something for "${r.q}": ${JSON.stringify(r.got)}`),
        `  on-topic: ${onHits}/${onResults.length} found the right lesson in the top 3 (${(onRate * 100).toFixed(0)}%, needs 90%)`,
        ...onResults.filter((r) => !r.ok).map((r) => `    missed "${r.q}": ${JSON.stringify(r.got)}`),
      ].join("\n") + "\n",
    );

    expect(offHits.map((r) => r.q), "off-topic questions must return nothing").toEqual([]);
    expect(onRate, "on-topic questions must find the right lesson in the top 3").toBeGreaterThanOrEqual(0.9);
  });
});
