// Sample publisher catalogue. Real prose, split into paragraphs.
// Each paragraph is priced per word in micro-USDC (1 µUSDC = $0.000001),
// so a paragraph costs a few thousandths of a cent — a price no card rail can serve.
//
// In a real deployment the publisher CMS supplies this; here it is static so the
// demo is deterministic and self-contained.

export const PER_WORD_UUSDC = 2n; // 2 micro-USDC per word ($0.000002/word)

export const ARTICLES = {
  "arc-nanopayments": {
    title: "Why the smallest payment is the hardest one",
    author: "lepton.press",
    paragraphs: [
      "For thirty years the web has had exactly one business model that pays writers reliably: bundle the work into something big enough to justify a card charge. A subscription, a course, a paywalled month. Anything cheaper than roughly fifty cents simply could not be sold, because the payment itself cost more than the thing being bought.",
      "That floor was never a law of nature. It was the cost of moving money through card networks: interchange, gateway fees, fraud reserves, chargeback risk. Those costs are fixed per transaction, so they crush small payments and vanish into large ones. The long tail of writing that is worth a tenth of a cent to a reader has been economically invisible the entire time.",
      "Stablecoins on a settlement-first chain change the arithmetic. When USDC is the native gas token and a block finalises in under a second, the marginal cost of a transfer collapses toward the gas itself. A payment of one millionth of a dollar stops being absurd and becomes routine. The smallest coin of antiquity, the lepton, finally has a digital equivalent.",
      "The first buyers of nanopaid content will not be humans clicking a tip jar. They will be agents: research bots, summarisers, retrieval pipelines that read thousands of sources and would happily pay each one a fraction of a cent rather than scrape it for free. Per-read settlement turns adversarial scraping into a market, and turns every paragraph into a metered good.",
      "What this needs is not a new token but a new toll booth: a way for a publisher to charge a machine per paragraph, prove the payment on chain, and release the text only after the money has actually vested. That is the whole of Lepton Press, and the rest of this article is the spec.",
    ],
  },
  "agent-reading-economics": {
    title: "How an agent decides what to pay for",
    author: "lepton.press",
    paragraphs: [
      "An autonomous reader does not consume an article the way a person does. It has a budget, a question, and a stopping rule. Each paragraph it buys either advances its task or does not, and a well-built agent stops paying the moment the marginal paragraph stops earning its price.",
      "That makes pricing legible in a way human attention never is. A publisher can watch, transaction by transaction, exactly how far agents read before they leave, which pieces earn their keep, and which openings are worth a premium because every agent buys past them.",
      "The settlement rail matters more than the model here. Streaming the payment per second of reading, rather than charging per article up front, means the agent risks almost nothing and the publisher is paid continuously for exactly the attention it captures. Either side can stop at any block.",
    ],
  },
};

export function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function paragraphPrice(text) {
  return BigInt(wordCount(text)) * PER_WORD_UUSDC; // micro-USDC
}
