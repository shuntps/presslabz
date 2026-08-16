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

  'dashboard.title': 'Tableau de bord',
  'dashboard.greeting': 'Connecté en tant que {name}',
  'dashboard.role': 'Rôle',
  'dashboard.capabilities': 'Capacités',
  'dashboard.empty': 'Rien ici pour l’instant. Le contenu arrive à la phase suivante.',

  'content.status.draft': 'Brouillon',
  'content.status.scheduled': 'Planifié',
  'content.status.published': 'Publié',
  'content.status.archived': 'Archivé',
  'content.status.trash': 'Corbeille',

  'error.notFound': 'Introuvable',
  'error.unauthorized': 'Vous n’êtes pas connecté',
  'error.forbidden': 'Vous n’avez pas la permission de faire cela',
  'error.unexpected': 'Une erreur est survenue',
}
