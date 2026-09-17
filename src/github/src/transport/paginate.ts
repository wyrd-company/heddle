/** Cursor pagination over a GraphQL connection. */
export interface Connection<T> {
  nodes?: readonly (T | null)[] | null;
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

/**
 * Turns a page fetcher into an AsyncIterable of nodes. The fetcher receives
 * the cursor to continue from (undefined for the first page).
 */
export async function* paginate<T>(
  fetchPage: (after: string | undefined) => Promise<Connection<T>>,
): AsyncGenerator<T, void, undefined> {
  let after: string | undefined;
  for (;;) {
    const page = await fetchPage(after);
    for (const node of page.nodes ?? []) {
      if (node !== null) yield node;
    }
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return;
    after = page.pageInfo.endCursor;
  }
}

/** Page-number pagination over a REST list endpoint. Stops on a short page. */
export async function* paginateRest<T>(
  fetchPage: (page: number, perPage: number) => Promise<readonly T[]>,
  perPage = 100,
): AsyncGenerator<T, void, undefined> {
  for (let page = 1; ; page += 1) {
    const items = await fetchPage(page, perPage);
    for (const item of items) yield item;
    if (items.length < perPage) return;
  }
}

/** Collects an AsyncIterable. Test and small-list convenience. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
