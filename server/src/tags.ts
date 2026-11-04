/* The tag vocabulary, bundled from shared/tags/ (checked by `npm run build:tags`, which runs before the server build) */
import { makeTagIndex } from "@shared/tags";
import main from "@shared/tags/tags.json";
import aliases from "@shared/tags/aliases.json";
import groups from "@shared/tags/groups.json";

export const tagIndex = makeTagIndex({ ...main, aliases, groups });
