import { z } from "zod";
import { DataforseoLabsGoogleDomainIntersectionLiveRequestInfo } from "dataforseo-client";
import { labsApi } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  parseTaskItems,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";

// Labs, continued. Domain intersection lives in its own module because
// labs.ts is at the 400-line lint cap and this endpoint brings its own item
// schema — the SDK types both of its serp_element fields as the loose base
// element, so the rank we read has to be validated rather than trusted.

const domainIntersectionItemSchema = z
  .object({
    keyword_data: z
      .object({
        keyword: z.string().nullable().optional(),
        keyword_info: z
          .object({
            search_volume: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        keyword_properties: z
          .object({
            keyword_difficulty: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        search_intent_info: z
          .object({
            main_intent: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    first_domain_serp_element: z
      .object({
        rank_group: z.number().nullable().optional(),
        rank_absolute: z.number().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type DomainIntersectionItem = z.infer<
  typeof domainIntersectionItemSchema
>;

/**
 * Keywords one domain ranks for and another doesn't — the keyword gap, read
 * from the competitor's side.
 *
 * `intersections: false` is what makes it a gap rather than an overlap: with
 * it, DataForSEO returns the keywords `target1` has results for and `target2`
 * has none for, and only the first domain's SERP element comes back (which is
 * why the item schema above reads one and not two). Ordered by the
 * competitor's rank so the head of a capped response is the keywords they
 * actually win, not the ones they scrape position 90 for.
 */
export async function fetchDomainIntersection(input: {
  target1: string;
  target2: string;
  locationCode: number;
  languageCode: string;
  limit: number;
  offset?: number;
}): Promise<DataforseoApiResponse<DomainIntersectionItem[]>> {
  const response = await labsApi().googleDomainIntersectionLive([
    new DataforseoLabsGoogleDomainIntersectionLiveRequestInfo({
      target_1: input.target1,
      target_2: input.target2,
      location_code: input.locationCode,
      language_code: input.languageCode,
      intersections: false,
      item_types: ["organic"],
      limit: input.limit,
      offset: input.offset,
      order_by: ["first_domain_serp_element.rank_group,asc"],
      include_serp_info: false,
      include_clickstream_data: false,
    }),
  ]);
  const task = assertOk(response);
  return {
    data: parseTaskItems(
      "google-domain-intersection-live",
      task,
      domainIntersectionItemSchema,
    ),
    billing: buildTaskBilling(task),
  };
}
