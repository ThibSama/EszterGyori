# Audit performance frontend

Date: 2026-06-14

## Portee

Audit centre sur le rendu public Next.js de `/`, avec verification de non-regression sur les routes admin protegees, l'aperçu admin et les frontieres public/admin. Aucun changement de contrat, d'API, d'authentification, de contenu ou de style fonctionnel n'a ete introduit.

## Baseline locale

Etat initial controle depuis un arbre Git propre:

- `contracts`: `npm ci`, `npm run typecheck`, `npm run build` passes.
- `front`: `npm ci`, `npm run test`, `npm run lint`, `npm run build` passes apres suppression de deux processus Next.js locaux qui verrouillaient un binaire genere dans `node_modules`.
- `API`: `npm ci`, `npm run typecheck`, `npm run build`, `npm run test` passes.
- Docker API: `docker build --progress=plain -f API/Dockerfile -t eszter-api:local .` passe.

Le build frontend produit toujours le log attendu lorsque `CONTENT_API_URL` pointe vers un exemple indisponible:

```text
Public content fallback { reason: 'CONTENT_API_NETWORK_FAILURE', hostname: 'api.example.com' }
```

## Analyse des assets

Mesure apres build production, avant optimisation:

| Type | Nombre | Octets |
| --- | ---: | ---: |
| JS | 17 | 1 297 682 |
| CSS | 1 | 89 279 |
| Fonts | 21 | 405 548 |
| Static total | - | 1 818 440 |

Mesure apres suppression de la police mono inutilisee:

| Type | Nombre | Octets |
| --- | ---: | ---: |
| JS | 17 | 1 297 682 |
| CSS | 1 | 87 382 |
| Fonts | 15 | 335 032 |
| Static total | - | 1 746 027 |

Gain conserve:

- 6 fichiers WOFF2 en moins.
- 70 516 octets de fonts en moins.
- 72 413 octets statiques en moins.
- Aucun changement de taille JS.

## Optimisation appliquee

La police `Geist_Mono` et la variable CSS `--font-mono` ont ete retirees parce qu'aucune source applicative ne les utilisait. La police sans-serif et la police display restent inchangées.

Cette optimisation est conservee car elle supprime des assets generes sans changer le rendu visible connu.

## Frontieres public/admin

Le code public inspecte ne reference pas les modules admin suivants:

- `content-editor`
- `admin-preview-viewport`
- `admin-draft-storage`
- `admin-appearance-editor`
- `auth/session`
- `localStorage`

Un test automatise garde cette isolation sur les sources publiques principales.

## Mesure navigateur locale

Une mesure Chrome headless locale a ete effectuee contre `http://localhost:3100/` en build production. Elle sert d'indication de non-regression locale, pas de score Lighthouse officiel.

| Largeur | FCP | LCP observe | CLS | Overflow horizontal | Lien public `/admin` |
| ---: | ---: | ---: | ---: | --- | --- |
| 390 px | 312 ms | 312 ms | 0 | non | non |
| 768 px | 192 ms | 192 ms | 0 | non | non |
| 1440 px | 1 948 ms | 1 948 ms | 0 | non | non |

La mesure 1440 px a montre un TTFB local plus eleve pendant cette execution. Elle n'a pas ete utilisee comme preuve Core Web Vitals definitive.

## Optimisations rejetees ou reportees

Les changements suivants ont ete explicitement rejetes pendant ce passage:

- prechargement manuel d'images sans mesure prouvant un gain LCP;
- suppression ou reecriture des animations;
- conversion generale de composants client en composants serveur;
- reecriture Tailwind ou refonte visuelle;
- ajout de Lighthouse, bundle analyzer ou autre dependance;
- modification du loader `CONTENT_API_URL`;
- optimisation d'images de contenu qui changerait le rendu ou la source canonique.

## Limites

Lighthouse CLI n'etait pas disponible localement et aucune dependance n'a ete ajoutee pour l'installer. Les Core Web Vitals reels de production Vercel n'ont donc pas ete confirmes dans ce passage.

L'admin authentifie n'a pas ete valide dans le navigateur faute d'identifiants fournis. Les routes protegees ont en revanche ete controlees: `/admin` et `/admin/preview` redirigent vers `/admin/login`.

## Suivi recommande

La prochaine validation performance devrait etre faite sur le deploiement Vercel final, avec Lighthouse ou PageSpeed Insights, sur mobile et desktop, sans cache de build precedent.
