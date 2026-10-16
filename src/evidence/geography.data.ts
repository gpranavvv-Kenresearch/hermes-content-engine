/**
 * Known countries and regions used to guess a fact's geography. Data only.
 * Extend freely; matching is case-insensitive on word boundaries, longest
 * name first. Aliases (short forms) are matched case-sensitively.
 */
export const COUNTRIES: readonly string[] = [
  'Afghanistan', 'Albania', 'Algeria', 'Angola', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahrain',
  'Bangladesh', 'Belarus', 'Belgium', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Bulgaria', 'Cambodia',
  'Cameroon', 'Canada', 'Chile', 'China', 'Colombia', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czech Republic',
  'Denmark', 'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Estonia', 'Ethiopia', 'Finland', 'France',
  'Georgia', 'Germany', 'Ghana', 'Greece', 'Guatemala', 'Hong Kong', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran',
  'Iraq', 'Ireland', 'Israel', 'Italy', 'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kuwait',
  'Laos', 'Latvia', 'Lebanon', 'Libya', 'Lithuania', 'Luxembourg', 'Malaysia', 'Malta', 'Mexico', 'Morocco', 'Mozambique',
  'Myanmar', 'Namibia', 'Nepal', 'Netherlands', 'New Zealand', 'Nigeria', 'Norway', 'Oman', 'Pakistan', 'Panama',
  'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saudi Arabia',
  'Senegal', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sweden',
  'Switzerland', 'Taiwan', 'Tanzania', 'Thailand', 'Tunisia', 'Turkey', 'Uganda', 'Ukraine', 'United Arab Emirates',
  'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Venezuela', 'Vietnam', 'Zambia', 'Zimbabwe',
];

export const REGIONS: readonly string[] = [
  'Asia Pacific', 'Asia-Pacific', 'Southeast Asia', 'South Asia', 'East Asia', 'Central Asia', 'Middle East and Africa',
  'Middle East', 'North Africa', 'Sub-Saharan Africa', 'Africa', 'Europe', 'Eastern Europe', 'Western Europe',
  'North America', 'Latin America', 'South America', 'Central America', 'Caribbean', 'Oceania', 'GCC', 'ASEAN', 'MENA',
  'APAC', 'European Union', 'Scandinavia', 'Nordics', 'CIS',
];

/** Case-sensitive short forms mapped to canonical names. */
export const GEOGRAPHY_ALIASES: Readonly<Record<string, string>> = {
  'U.S.': 'United States',
  USA: 'United States',
  US: 'United States',
  UK: 'United Kingdom',
  UAE: 'United Arab Emirates',
  KSA: 'Saudi Arabia',
  EU: 'European Union',
  'Asia-Pacific': 'Asia Pacific',
  APAC: 'Asia Pacific',
};
