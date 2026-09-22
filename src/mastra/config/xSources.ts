import type { Source } from "../schemas/source";
import { xHandle } from "./sourceCatalog1";

/**
 * X accounts from the source list. All are inactive SOCIAL stubs
 * (role signal_creator unless noted): no scraping, ever. Activate only
 * via the official X API or a compliant provider.
 */
const AI = ["LLMs", "Generative AI"];
const AGENTS = ["AI Agents"];
const CODE = ["AI Coding"];
const STARTUPS = ["AI Startups"];
const RESEARCH = ["AI Research"];

function handles(list: string[], topics: string[], authority = 50): Source[] {
  return list.map((h) => xHandle(h, topics, authority));
}

// 12. AI researchers / technical experts
const RESEARCHERS = handles(
  [
    "karpathy", "ylecun", "AndrewYNg", "DarioAmodei", "demishassabis",
    "drfeifei", "fchollet", "stanfordnlp", "rasbt", "chipro",
    "lilianweng", "jeremyphoward", "nlmnp", "iamshreya", "hamelsmu",
    "eugeneyan", "svpino", "jimfanatmeta", "ykilcher", "simonw",
    "hwchase17", "jerryjliu0", "karpathy",
  ],
  [...RESEARCH, ...AI],
  60,
);

// 13. AI company execs / founders
const EXECS = handles(
  [
    "sama", "gdb", "DarioAmodei", "DanielaAmodei", "demishassabis",
    "mustafasuleyman", "jensenhuang", "finkd", "alexandr_wang",
    "AravSrinivas", "NoamShazeer", "elonmusk", "LoganKilpatrick",
    "ClementDelangue", "GuillaumeLample", "ArthurMensch",
    "natfriedman", "danielgross", "hwchase17", "jerryjliu0",
    "aiden_gomez", "drfeifei", "AndrewYNg", "karpathy",
  ],
  [...AI, ...STARTUPS],
  58,
);

// 14. Developer / builder accounts
const BUILDERS = handles(
  [
    "theo", "dhh", "jasonfried", "rauchg", "leeerobinson",
    "dan_abramov", "addyosmani", "kentcdodds", "ThePrimeagen",
    "fireship_dev", "cassidoo", "tannerlinsley", "ry", "tjholowaychuk",
    "mitchellh", "simonw", "swyx", "hwchase17", "hamelsmu",
    "chipro", "eugeneyan", "bentossell", "levelsio", "marc_lou",
    "tibo_maker", "arvidkahl", "dvassallo", "sahilbloom",
    "jackbutcher", "gregisenberg",
  ],
  [...CODE, "AI Infrastructure"],
  52,
);

// 15. AI / prompt / creator accounts (SIGNAL only)
const CREATORS = handles(
  [
    "RowanCheung", "MattWolfe", "alliekmiller", "tibo_maker",
    "godofprompt", "AIExplained", "mattvidic", "lennyrachitsky",
    "swyx", "fireship_dev",
  ],
  AI,
  48,
);

// 16. Founder / startup / business
const FOUNDERS = handles(
  [
    "paulg", "garrytan", "sama", "jasonfried", "dhh",
    "levelsio", "sahilbloom", "arvidkahl", "dvassallo",
    "lennyrachitsky", "bchesky", "patrickc",
    "dylanfield", "tobi", "brian_armstrong", "naval",
    "balajis", "DavidSacks", "eladgil", "garrytan",
    "pmarca", "bhorowitz", "paulbuchheit",
  ],
  STARTUPS,
  55,
);

// 17. India tech / AI / startup voices
const INDIA_VOICES = handles(
  [
    "hkirat", "varunmayya", "kunalb11", "nikhilkamathcio",
    "bhash", "suhail", "aaditsh", "ankurwarikoo",
    "riteshagar", "kunalbahl", "deepigoyal", "peyushbansal",
    "ashneergrover", "agrawalharsh", "sreeramk",
  ],
  STARTUPS,
  48,
);

function dedupe(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

export const X_SOURCES: Source[] = dedupe([
  ...RESEARCHERS,
  ...EXECS,
  ...BUILDERS,
  ...CREATORS,
  ...FOUNDERS,
  ...INDIA_VOICES,
]);
