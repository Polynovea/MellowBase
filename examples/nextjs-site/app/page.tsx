import { createCmsClient } from "@polynovea/cms-sdk";
import { schema, type ArticleItem, type Models } from "../polynovea-cms";

export const revalidate = 60;

/** Server-only: the token never reaches the browser (no NEXT_PUBLIC_ variable). */
function cms() {
  const baseUrl = process.env.POLYNOVEA_CMS_URL;
  const token = process.env.POLYNOVEA_CMS_TOKEN;
  if (!baseUrl || !token) return null;
  return createCmsClient<Models>({ baseUrl, token, schema });
}

async function getArticles(): Promise<ArticleItem[]> {
  const client = cms();
  if (!client) return [];
  const { data } = await client.items("article").list({
    filter: { publishedAt: { null: false } },
    sort: ["-published_on", "title"],
    expand: ["author"],
    limit: 20,
  });
  return data;
}

function authorName(article: ArticleItem): string | null {
  const author = article.data.author;
  return author && typeof author === "object" ? author.data.name ?? null : null;
}

export default async function Page() {
  const articles = await getArticles();
  return (
    <main style={{ maxWidth: 760, margin: "64px auto", fontFamily: "system-ui", padding: 24 }}>
      <h1>Published with Polynovea CMS</h1>
      {articles.length === 0 ? (
        <p>Set POLYNOVEA_CMS_URL and POLYNOVEA_CMS_TOKEN (server-only), pull your types, then publish an article.</p>
      ) : (
        articles.map((article) => (
          <article key={article.id}>
            <h2>{article.data.title ?? "Untitled"}</h2>
            <p>
              {article.data.published_on}
              {authorName(article) ? ` · ${authorName(article)}` : ""}
            </p>
            {article.data.tags?.length ? <p>{article.data.tags.join(", ")}</p> : null}
          </article>
        ))
      )}
    </main>
  );
}
