import type { APIRequestContext } from "@playwright/test";

/** Every page the site builds, found from index.json so the list grows with the lessons. */
export async function allPages(request: APIRequestContext): Promise<string[]> {
  const index = (await (await request.get("/index.json")).json()) as {
    lessons: { id: string }[];
    teachers: Record<string, { login: string }>;
  };
  return [
    "/",
    "/lessons/",
    "/teach/",
    ...index.lessons.map((l) => `/lessons/${l.id}/`),
    ...Object.values(index.teachers).map((t) => `/@${t.login.toLowerCase()}`),
    "/no-such-page/",
  ];
}
