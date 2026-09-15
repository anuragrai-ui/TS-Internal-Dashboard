const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

export interface ConfluenceSearchResult {
  excerpt: string;
  title: string;
  url: string;
}

interface ConfluenceContentBody {
  view?: {
    value?: string;
  };
}

interface ConfluenceSearchResponseItem {
  body?: ConfluenceContentBody;
  title?: string;
  _links?: {
    webui?: string;
  };
}

interface ConfluenceSearchResponse {
  results?: ConfluenceSearchResponseItem[];
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Confluence Cloud's content search does NOT return an "excerpt" field by
 * default (confirmed live - the "excerpt" query param and expand=excerpt
 * both come back empty). Getting real text requires expand=body.view, which
 * returns the page's rendered HTML in body.view.value - stripped and
 * truncated below into something short enough for an LLM tool result.
 */
export async function searchConfluence(query: string, limit = 5): Promise<ConfluenceSearchResult[]> {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return [];
  }

  const baseUrl = JIRA_BASE_URL.replace(/\/+$/, "");
  const escapedQuery = query.replace(/"/g, '\\"');
  const url = new URL(`${baseUrl}/wiki/rest/api/content/search`);
  url.searchParams.set("cql", `text ~ "${escapedQuery}"`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("expand", "body.view");

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.warn(`Confluence search failed with status ${response.status}.`);
      return [];
    }

    const data = (await response.json()) as ConfluenceSearchResponse;

    return (data.results ?? []).map((item) => ({
      excerpt: stripHtml(item.body?.view?.value ?? "").slice(0, 400) || "(no preview available)",
      title: item.title ?? "Untitled",
      url: item._links?.webui ? `${baseUrl}${item._links.webui}` : baseUrl,
    }));
  } catch (error) {
    console.warn("Confluence search request failed.", error);
    return [];
  }
}
