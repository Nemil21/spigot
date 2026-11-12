import type { BlogPost } from './types.js';

// Ten unstructured posts. The schema agent should skip /blog/* (features/04).
export const BLOG_POSTS: BlogPost[] = [
  post('how-to-read-a-texas-lease', 'How to read a Texas lease without losing an afternoon', '2026-08-04', [
    'Most leases we see run about twelve pages, and the parts that matter fit on one. Start with the dates, the rent, and who pays which utilities.',
    'Then look for the early-termination clause. If you might move for work, ask the landlord what a buy-out costs before you sign, not after.',
    'Finally, read the repair section twice. It tells you who to call at 2 a.m. when the water heater gives up.',
  ]),
  post('summer-electric-bills', 'Keeping summer electric bills sane', '2026-07-12', [
    'August in Central Texas is long. Ask for the last twelve months of bills for a unit before you apply; most landlords will share an average.',
    'Ceiling fans, blackout curtains and a programmable thermostat do more than you would think. So does a unit that faces north.',
  ]),
  post('pets-and-rentals', 'Renting with pets: deposits, fees and the fine print', '2026-06-21', [
    'A pet deposit is refundable; pet rent is not. Some listings charge both, so ask which one you are looking at.',
    'Breed and weight limits vary by building. Our listings show a simple pets field, but always confirm with the agent.',
  ]),
  post('first-apartment-checklist', 'A first-apartment checklist we actually use', '2026-05-30', [
    'Run every tap, flush every toilet, open every window. Take dated photos of anything scuffed before you move a single box in.',
    'Check that the smoke alarms chirp when tested and that the deadbolt turns smoothly. Note it all on the move-in form.',
  ]),
  post('neighbourhood-guide-east-side', 'Neighbourhood notes: the east side', '2026-05-02', [
    'Holly, Govalle and Cherrywood each feel different, even a few blocks apart. Walk them on a weekday evening before you decide.',
    'Bus coverage is good along the main corridors and patchy on side streets. Map your commute both ways.',
  ]),
  post('roommates-and-joint-leases', 'Roommates and joint leases', '2026-04-11', [
    'On a joint lease, every tenant is responsible for the full rent. Agree in writing who pays what, and what happens if someone moves out.',
    'Some landlords allow a replacement roommate with an application fee. Ask before you need it.',
  ]),
  post('application-documents', 'What to have ready before you apply', '2026-03-19', [
    'Two recent pay stubs or an offer letter, a photo ID, and contact details for a previous landlord cover most applications.',
    'Good units go quickly in the spring. Having the paperwork ready often matters more than being first to tour.',
  ]),
  post('storm-season-prep', 'Storm season prep for renters', '2026-03-01', [
    'Renters insurance is cheap compared to replacing a laptop and a couch. Check whether your policy covers water damage from outside.',
    'Keep a flashlight, a phone battery and a few gallons of water somewhere you can find them in the dark.',
  ]),
  post('moving-out-deposit', 'Getting your deposit back', '2026-02-08', [
    'Texas landlords have thirty days after you move out to return a deposit or send an itemised list of deductions.',
    'Leave a forwarding address in writing, clean to the standard you found, and photograph every room on the way out.',
  ]),
  post('about-our-listings', 'How we keep listings up to date', '2026-01-15', [
    'Every listing page shows when it was last updated. When a unit leases, we mark it Leased rather than deleting the page.',
    'If you spot something out of date, tell the listing agent; their phone number is on every page.',
  ]),
];

function post(slug: string, title: string, published_on: string, paragraphs: string[]): BlogPost {
  return { slug, title, published_on, paragraphs, updated_at: `${published_on}T15:00:00Z` };
}
