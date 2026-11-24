// Every line after a @ts-expect-error must fail to type-check (see compile.test.ts, which also checks
// that each one fails on its own line).
import { createCmsClient } from "../src/index.js";
import { schema, type Models } from "./fixture/polynovea-cms.js";

const cms = createCmsClient<Models>({ baseUrl: "https://cms.example.test", token: "pnv_test", schema });
const articles = cms.items("article");

export async function mistakes() {
  // @ts-expect-error a hidden field cannot be filtered
  await articles.list({ filter: { secret: { eq: "x" } } });
  // @ts-expect-error contains is not an operator for an integer
  await articles.list({ filter: { rating: { contains: "x" } } });
  // @ts-expect-error a condition has exactly one operator
  await articles.list({ filter: { title: { eq: "a", neq: "b" } } });
  // @ts-expect-error a condition has exactly one field (use and)
  await articles.list({ filter: { title: { eq: "a" }, rating: { gt: 1 } } });
  // @ts-expect-error a to-many relation cannot be filtered
  await articles.list({ filter: { related: { null: true } } });
  // @ts-expect-error the operator's value has the field's type
  await articles.list({ filter: { rating: { gt: "3" } } });
  // @ts-expect-error not one of the multi-select options
  await articles.list({ filter: { tags: { contains: "nope" } } });
  // @ts-expect-error a multi-select is not sortable
  await articles.list({ sort: "tags" });
  // @ts-expect-error a hidden field cannot be sorted
  await articles.list({ sort: ["secret"] });
  // @ts-expect-error at most three sort keys
  await articles.list({ sort: ["title", "rating", "id", "slug"] });
  // @ts-expect-error expansion follows relations, two levels at most
  await articles.list({ expand: ["author.company"] });
  // @ts-expect-error a hidden field cannot be requested
  await articles.list({ fields: ["secret"] });
  // @ts-expect-error rating is read-only for this caller
  await articles.create({ title: "x", rating: 3 });
  // @ts-expect-error title is required on create
  await articles.create({ slug: "x" });
  // @ts-expect-error person is read-only for this caller
  await cms.items("person").create({ name: "x" });
  // @ts-expect-error person cannot be updated either
  await cms.items("person").update("id", { name: "x" });
  // @ts-expect-error not a model this token can read
  cms.items("payroll");
  const page = await articles.list();
  // @ts-expect-error a hidden field is not in the data
  void page.data[0]?.data.secret;
}
