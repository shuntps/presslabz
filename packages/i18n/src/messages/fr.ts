import type { Messages } from './en.ts'

/** Typed as Messages, so an omitted key fails typecheck. */
export const fr: Messages = {
  'common.save': 'Enregistrer',
  'common.cancel': 'Annuler',
  'common.delete': 'Supprimer',
  'common.search': 'Rechercher',
  'common.loading': 'Chargement…',

  'theme.label': 'Thème',
  'theme.light': 'Clair',
  'theme.dark': 'Sombre',
  'theme.system': 'Système',

  'locale.label': 'Langue',

  'auth.signIn': 'Se connecter',
  'auth.signingIn': 'Connexion…',
  'auth.signOut': 'Se déconnecter',
  'auth.email': 'Courriel',
  'auth.password': 'Mot de passe',
  'auth.invalidCredentials': 'Ce courriel et ce mot de passe ne correspondent pas',
  'auth.tooManyAttempts': 'Trop de tentatives. Réessayez plus tard.',
  'auth.tagline': 'Composer, traduire, publier.',

  'dashboard.title': 'Tableau de bord',
  'dashboard.name': 'Nom',
  'dashboard.role': 'Rôle',
  'dashboard.capabilities': 'Capacités',
  'dashboard.empty': 'Rien ici pour l’instant. Le contenu arrive à la phase suivante.',

  'content.status.draft': 'Brouillon',
  'content.status.scheduled': 'Planifié',
  'content.status.published': 'Publié',
  'content.status.archived': 'Archivé',
  'content.status.trash': 'Corbeille',

  'content.type.post.plural': 'Articles',
  'content.type.page.plural': 'Pages',
  'content.column.title': 'Titre',
  'content.column.language': 'Langue',
  'content.column.updated': 'Modifié',
  'content.column.status': 'État',
  'content.count': '{total} au total · {drafts} en brouillon',
  'content.empty': 'Rien d’écrit pour l’instant. Le premier commence ici.',
  'content.gap': 'Écart',
  'content.gapCount': '{count} publiés ici n’ont pas encore de version dans l’autre langue.',
  'content.untranslated': 'Pas de traduction',

  'nav.dashboard': 'Tableau de bord',
  'nav.compose': 'Composer',

  'error.notFound': 'Introuvable',
  'error.unauthorized': 'Vous n’êtes pas connecté',
  'error.forbidden': 'Vous n’avez pas la permission de faire cela',
  'error.unexpected': 'Une erreur est survenue',
}
