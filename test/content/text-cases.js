// OWNER: Agent C. Sentences for the explicit-text check. The same words in harmless and in sexual contexts.
// Explicit lines are mild and written for this test.
export const TEXT_CASES = [
  // harmless uses of "trigger" words
  { explicit: false, text: 'Sex: Male / Female / Prefer not to say' },
  { explicit: false, text: 'Please enter your date of birth and sex as shown on your passport.' },
  { explicit: false, text: 'The study found no difference between the sexes in reaction time.' },
  { explicit: false, text: 'Sex education is part of the national curriculum for secondary schools.' },
  { explicit: false, text: 'Early detection of breast cancer saves lives: book your screening today.' },
  { explicit: false, text: 'Chicken breast, skinless, 500 g, on offer this week.' },
  { explicit: false, text: 'The naked eye cannot see stars this faint without a telescope.' },
  { explicit: false, text: 'The exam was really hard, but I think I passed.' },
  { explicit: false, text: 'Mating season for frogs begins in early spring when the ponds thaw.' },
  { explicit: false, text: 'She kissed her grandmother goodbye and got on the train.' },
  { explicit: false, text: 'Click the button below to reset your password.' },
  { explicit: false, text: 'Rated 18+ for violence and strong language.' },
  { explicit: false, text: 'Puberty brings many changes to the body; talk to a doctor if you are worried.' },
  { explicit: false, text: 'The couple got married in June and moved into a small flat in Leeds.' },
  { explicit: false, text: 'Undress the doll and put her pyjamas on before bedtime.' },
  { explicit: false, text: 'Our models walked the runway in the new summer collection.' },
  // explicit / sexual writing (smut-style)
  { explicit: true, text: 'He pulled her onto the bed and slowly undressed her, kissing his way down her naked body.' },
  { explicit: true, text: 'They had sex all night, moaning as she rode him harder and harder.' },
  { explicit: true, text: 'She slid her hand into his pants and felt how hard he was.' },
  { explicit: true, text: 'Hot singles want to hook up tonight. Click for nude pics.' },
  { explicit: true, text: 'Her breasts pressed against his chest as he thrust into her.' },
  { explicit: true, text: 'Watch free porn videos of hot amateur couples, no sign-up.' },
  { explicit: true, text: 'He licked her nipples while she spread her legs for him.' },
  { explicit: true, text: 'The sexting messages described exactly what he wanted to do to her body in bed.' },
];

// Held out: written AFTER the models and the hypothesis were chosen, never used for tuning.
export const HELDOUT_CASES = [
  { explicit: false, text: 'Gender: ☐ M ☐ F  Sex assigned at birth (optional)' },
  { explicit: false, text: 'Breastfeeding support groups meet every Thursday at the community centre.' },
  { explicit: false, text: 'Cucumbers grow best in warm, well-drained soil with plenty of sun.' },
  { explicit: false, text: 'The statue of David is a nude sculpture by Michelangelo, completed in 1504.' },
  { explicit: false, text: 'Bees pollinate flowers while collecting nectar for the hive.' },
  { explicit: false, text: 'He was hard on himself after losing the match.' },
  { explicit: false, text: 'Strip the old paint off the door before sanding it.' },
  { explicit: false, text: 'Romeo and Juliet fall in love at first sight at the Capulet feast.' },
  { explicit: false, text: 'The doctor examined his chest and listened to his breathing.' },
  { explicit: false, text: 'Same-sex marriage was legalised in the country in 2014.' },
  { explicit: false, text: 'Swimwear sale: 30% off bikinis and swim shorts this weekend.' },
  { explicit: false, text: 'Hold your partner\'s hand and lead them across the dance floor.' },
  { explicit: false, text: 'The baby was having a bath and splashing happily.' },
  { explicit: false, text: 'Use protection: sunscreen of SPF 30 or higher when outdoors.' },
  { explicit: false, text: 'Lie on the bed face down and the physiotherapist will massage your lower back.' },
  { explicit: false, text: 'Sexual reproduction in plants involves pollen reaching the stigma.' },
  { explicit: true, text: 'She moaned his name as he kissed her inner thighs, his fingers slipping inside her.' },
  { explicit: true, text: 'Live cam girls are waiting to strip for you right now. Join free.' },
  { explicit: true, text: 'His cock throbbed as she wrapped her lips around it.' },
  { explicit: true, text: 'They fucked against the wall until both of them came.' },
  { explicit: true, text: 'She peeled off her bra and let him cup her bare breasts.' },
  { explicit: true, text: 'Send me a naughty pic of you naked in the shower ;)' },
  { explicit: true, text: 'He bent her over the desk, pushed up her skirt and took her from behind.' },
  { explicit: true, text: 'Erotic massage with a happy ending, discreet incall available.' },
];

// Context windows as the screen pipeline builds them (neighbouring lines joined) from test/content/text-screen.html.
export const SCREEN_CASES = [
  { explicit: false, text: 'Weekly shop Chicken breast, skinless, 500 g, £3.20. Cucumbers, 2 for £1.' },
  { explicit: false, text: 'Weekly shop Chicken breast, skinless, 500 g, £3.20. Cucumbers, 2 for £1. Strip the old paint off the door before sanding it.' },
  { explicit: false, text: 'Chicken breast, skinless, 500 g, £3.20. Cucumbers, 2 for £1. Strip the old paint off the door before sanding it.' },
  { explicit: false, text: 'Sex: • Male • Female • Prefer not to say Breast screening in the last 3 years? • Yes • No' },
  { explicit: false, text: 'David, a nude sculpture by Michelangelo, was completed in 1504. Sex education is part of the curriculum.' },
  { explicit: true, text: 'fingers slipped between her thighs, and they had sex until morning.' },
  { explicit: true, text: 'Chapter 7 He pulled her onto the bed and slowly undressed her, kissing' },
  { explicit: true, text: 'Hot singles near you want to hook up tonight. Click for nude pics, live cam girls strip for you now. Join free!' },
];
