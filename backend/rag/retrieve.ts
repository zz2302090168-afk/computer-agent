import { knowledge } from '../../knowledge/library';
// Local lexical retrieval with Chinese bigrams. Model generation consumes these cited chunks when configured.
function tokens(text: string) {
  const s = text.toLowerCase();
  return [
    ...new Set(
      [...s.matchAll(/[a-z0-9]+|[\u4e00-\u9fff]/g)]
        .map((x) => x[0])
        .concat([...s.matchAll(/(?=([\u4e00-\u9fff]{2}))/g)].map((x) => x[1])),
    ),
  ];
}
export function retrieveKnowledge(query: string, limit = 4) {
  const q = tokens(query);
  return knowledge
    .map((k) => {
      const body = k.title + ' ' + k.tags.join(' ') + ' ' + k.content;
      const t = tokens(body);
      return {
        ...k,
        score: q.reduce(
          (s, w) =>
            s +
            (t.includes(w)
              ? Math.log(
                  1 +
                    knowledge.length /
                      (1 +
                        knowledge.filter((x) =>
                          (x.title + x.content).includes(w),
                        ).length),
                )
              : 0),
          0,
        ),
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(10, limit)));
}
