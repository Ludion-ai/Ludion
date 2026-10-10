/**
 * Which teacher id owns which page. Pages live at the lowercase login. If two ids end up with the same
 * lowercase login (possible only when a lookup failed and someone else now holds that name), the id whose
 * login came from the API gets the page; if neither did, neither gets one. See docs/decisions.md.
 */
export function teacherPages(logins: Map<number, string>, resolved: Set<number>): Map<string, number> {
  const byName = new Map<string, number[]>();
  for (const [id, login] of logins) {
    const key = login.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), id]);
  }
  const pages = new Map<string, number>();
  for (const [name, ids] of byName) {
    if (ids.length === 1) {
      pages.set(name, ids[0]!);
      continue;
    }
    const fromApi = ids.filter((id) => resolved.has(id));
    if (fromApi.length === 1) pages.set(name, fromApi[0]!);
  }
  return pages;
}
