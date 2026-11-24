// Must type-check with zero errors against the fixture types file (see compile.test.ts).
import { createCmsClient, type ItemRecord } from "../src/index.js";
import { schema, type ArticleData, type Models } from "./fixture/polynovea-cms.js";

const cms = createCmsClient<Models>({ baseUrl: "https://cms.example.test", token: "pnv_test", schema, preview: "preview-token" });

export async function typedUse() {
  const page = await cms.items("article").list({
    filter: { and: [{ title: { contains: "launch" } }, { or: [{ rating: { gt: 3 } }, { author: { name: { eq: "Asha" } } }] }, { not: { featured: { eq: false } } }, { tags: { contains: "news" } }, { publishedAt: { null: false } }] },
    sort: ["-published_on", "title"],
    expand: ["author", "related.author"],
    fields: ["title", "rating"],
    limit: 20,
    cursor: null,
  });
  const items: Array<ItemRecord<ArticleData>> = page.data;
  const title: string | undefined = items[0]?.data.title;
  const next: string | null = page.meta.page.nextCursor;
  const author = items[0]?.data.author;
  const authorName: string | undefined = author && typeof author !== "string" ? author.data.name : undefined;
  const tags: Array<"news" | "guide" | "release"> | undefined = items[0]?.data.tags;

  const one = await cms.items("article").get("id", { expand: ["author"], variant: "draft", preview: "other-token" });
  const rating: number | undefined = one.data.data.rating;
  await cms.items("article").create({ title: "Hello", tags: ["guide"], author: "00000000-0000-0000-0000-000000000000" });
  await cms.items("article").update("id", { featured: true });
  await cms.items("article").delete("id");
  await cms.items("article").list({ sort: "-rating", filter: { id: { in: ["a", "b"] } } });

  await cms.items("person").list({ sort: "name", filter: { email: { contains: "@" } } });
  for await (const person of cms.items("person").all({ limit: 50 })) {
    const name: string | undefined = person.data.name;
    void name;
  }
  return { title, next, authorName, tags, rating };
}

export async function looseUse() {
  const loose = createCmsClient({ baseUrl: "http://localhost:3000", token: "pnv_test" });
  const page = await loose.items("anything").list({ filter: { whatever: { eq: 1 } }, sort: "x", expand: ["y"] });
  const value: unknown = page.data[0]?.data.whatever;
  await loose.items("anything").create({ any: "thing" });
  return value;
}
