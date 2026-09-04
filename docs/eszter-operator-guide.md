# Guide d’exploitation — Eszter

Ce guide décrit les gestes quotidiens. Il ne contient aucun mot de passe. Conserver
les accès dans le gestionnaire de mots de passe convenu, jamais dans un e-mail, une
capture d’écran ou ce dépôt.

## Connexion et contenu

Ouvrir `https://<SITE>/admin`. Une page d’administration ouverte sans session doit
renvoyer vers la connexion. Se déconnecter après usage, surtout sur un appareil
partagé. Après plusieurs échecs, attendre le délai affiché : la limitation protège
le compte et ne signifie pas que le mot de passe a changé.

L’éditeur distingue deux états :

- **Brouillon** : enregistrer conserve les modifications dans l’administration,
  sans changer le site public.
- **Publié** : publier rend le brouillon visible sur le site. Relire la page publique
  après publication. Si l’éditeur signale un conflit de révision, ne pas écraser :
  recharger, comparer avec l’autre modification, puis refaire le changement.

La réinitialisation du brouillon reprend la version publiée et abandonne les
modifications non publiées. Utiliser cette action seulement après confirmation.

## Médias

Dans la bibliothèque, importer uniquement une image JPEG, PNG ou WebP attendue,
puis vérifier la miniature. L’application valide et réencode l’image. Supprimer les
images inutilisées pour garder une bibliothèque lisible. Une image encore utilisée
par le brouillon **ou** le site publié ne peut pas être supprimée : remplacer/enlever
sa référence, publier si nécessaire, puis réessayer. Ne jamais déposer de fichier à
la main dans le dossier `media/`.

## Réservations

Le calendrier admin est la source de vérité. Rechercher par période ou par référence
`bk_…`; vérifier l’heure affichée en Europe/Paris et l’état `confirmé`/`annulé`.

- **Modifier les coordonnées** corrige le nom, l’e-mail, le téléphone ou la note,
  sans déplacer le rendez-vous.
- **Déplacer** : demander d’abord les créneaux disponibles, choisir un créneau
  retourné par le serveur, confirmer l’action et vérifier la nouvelle heure dans le
  calendrier. Un e-mail de déplacement et un nouveau rappel sont alors planifiés.
- **Annuler** : saisir une raison utile mais sobre, confirmer et vérifier l’état
  annulé. Une annulation ne supprime jamais l’historique.

Ne jamais modifier directement les tables MySQL. Les actions admin maintiennent en
une transaction le rendez-vous, son historique et les notifications.

## Horaires et exceptions

Les horaires hebdomadaires sont remplacés comme un ensemble : relire **tous** les
jours avant d’enregistrer, vérifier que les plages ne se chevauchent pas, puis tester
un créneau public. Une exception s’applique à une date précise et remplace les
horaires habituels de cette date :

- exception fermée : aucun créneau ce jour-là ;
- exception ouverte : seules ses plages sont disponibles ;
- suppression de l’exception : retour aux horaires hebdomadaires.

Vérifier particulièrement les jours de changement d’heure. L’interface et le
serveur travaillent en Europe/Paris ; ne convertir aucune heure à la main en UTC.

## E-mails et SMS

En production, `notifications.email.encryption` doit être `starttls` (TLS
obligatoire après le dialogue SMTP) ou `smtps` (TLS implicite dès la connexion).
Le mode `none` — SMTP en clair — est réservé au développement et aux tests, où un
relais local en clair est un choix délibéré ; la configuration de production le
refuse au chargement, avant tout envoi.

Une réservation crée une confirmation et un rappel ; un déplacement rend l’ancien
rappel obsolète et en planifie un nouveau ; une annulation retire les rappels et
planifie l’annulation. Le cron SMTP doit tourner chaque minute. Un e-mail peut être
retenté : ne pas relancer manuellement plusieurs fois sans vérifier la file et le
journal, au risque de créer un doublon humain.

Les **SMS sont post-V1** (ESZ-075–079, ESZ-088/089) : aucune interface ni livraison
SMS n’est disponible et leur absence n’est pas une panne de la V1.

## Sauvegarde et restauration

L’opérateur d’hébergement exécute `app/bin/backup.php` vers le dossier privé
`backups/`, jamais sous `public_html/`. Conserver une copie chiffrée hors du serveur,
appliquer la rétention décidée et répéter régulièrement une restauration dans une
base et un dossier de test vides. Le détail et les commandes sont dans
[`backup-and-restore.md`](backup-and-restore.md).

Une restauration de production exige `--overwrite` si la cible contient des données
et `--allow-production`. Elle invalide les sessions. Avant de rapporter le succès,
elle applique la rétention des données client (ESZ-140) : les réservations dont les
90 jours sont écoulés sont anonymisées et leurs notifications en attente retirées.
Inspecter ensuite les notifications restaurées restantes afin de ne pas renvoyer un
ancien message. Ne jamais restaurer « pour voir » sur la production.

## En cas d’incident

### Les e-mails n’arrivent pas

1. Noter une référence de réservation et l’heure, sans copier les données client.
2. Vérifier que le rendez-vous et son action sont bien visibles dans l’admin.
3. Vérifier la dernière exécution du cron exclusif et les fichiers
   `var/log/notification-cron.log` et `var/log/notifications.log`.
4. Distinguer `pending` (à envoyer), `processing` (bail en cours), `failed` (échec
   terminal) et `skipped` (rappel devenu inutile/canal désactivé).
5. Vérifier la configuration SMTP, le quota fournisseur et le dossier spam de la
   boîte autorisée. Ne jamais coller identifiants, corps de message ou DSN dans un
   ticket. Après correction, lancer **un** tick autorisé et vérifier la réception.

### Le cron ne tourne pas

Vérifier dans konsoleH : cadence chaque minute, mode exclusif, PHP ≥ 8.2, répertoire
de travail et chemins absolus. Exécuter une fois depuis le panneau puis lire la
sortie ; « lancé » dans le panneau ne veut pas dire « terminé avec succès ». Ne pas
créer un deuxième cron concurrent pour compenser.

### Une réservation échoue

Vérifier le service actif, les horaires/exceptions de la date, le fuseau Paris, les
réservations et buffers voisins, puis les limites anti-abus (`429` demande
d’attendre). L’ouverture de session anonyme est aussi bornée : une adresse qui répète
`GET /api/auth/session` sans conserver le cookie finit par recevoir `429`
`RATE_LIMITED` (délai indiqué par `Retry-After`) ; conserver le cookie n’est jamais
facturé, et chaque nouvelle admission déclenche le nettoyage borné des sessions
expirées. Un `409 SLOT_UNAVAILABLE` signifie qu’un autre client a pris ou rendu
indisponible le créneau : recharger les disponibilités. En cas de `500`, noter
l’identifiant de requête et l’heure, ne pas multiplier les essais, puis consulter le
journal et l’état MySQL. Ne jamais créer le rendez-vous directement en base.

### Le site ou l’admin ne répond plus

Tester `/api/health`, puis `/api/content`; vérifier l’espace disque, les permissions,
la configuration PHP et MySQL et la dernière mise en production. Préserver les
journaux et prendre une sauvegarde si l’état reste lisible. Ne pas modifier plusieurs
causes à la fois. Suivre [`deployment-runbook.md`](deployment-runbook.md) pour les
contrôles de déploiement et la procédure de retour à une version connue.

`/api/health` ne prouve que la **vivacité** (liveness) : ce chemin ne lit aucun
fichier et ne touche aucune base, donc un `200` ne dit rien de l’état de MySQL ni du
contenu publié. Pour vérifier que le produit composé répond — santé, page publique,
enveloppe publiée et au moins un service réservable — utiliser la sonde en lecture
seule du projet : `npm run readiness:probe -- --origin=https://<origine>/`
(`scripts/readiness.mjs`, ESZ-127). Elle est réutilisée par le mode lecture seule de
l’acceptance de production.

La commande hôte `/usr/bin/php bin/preflight-production.php
--config=/usr/home/<FTP_LOGIN>/eszter/config/config.php` est obligatoire avant le
déploiement et avant de clôturer l’acceptation. Elle prouve, avec l’identité PHP
d’exécution, la création du répertoire cible, l’ouverture du journal en ajout, son
mode effectif exact `0600`, puis une écriture complète et vidée vers le fichier. La
sonde HTTP ESZ-127 prouve uniquement les dépendances de service : elle ne contrôle
pas ces préconditions hôte, ne remplace pas ce preflight et ne suffit jamais seule à
déclarer la production acceptable.
