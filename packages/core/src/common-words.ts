// Common words: everyday English plus the generic words of programming (file, error, module, version, ...).
// A question word on this list is a weak match: alone it never returns a lesson (search.ts).
// Any other word (an identifier like distutils, a tool name, a rare word) is a strong match.
// Base forms only; search.ts adds the -s, -ed, -ing, -er and -ly forms.

const ENGLISH =
  "able accept access according account across act action active actual actually add address admit adult affect afraid " +
  "afternoon against age agency agent ago agree ahead air allow almost alone along already although always amount analysis " +
  "ancient anger angle animal annual another answer anyone anything anyway apart appear apply approach area argue arm army " +
  "around arrive art article artist ask assume attack attempt attend attention author available avoid away baby back bad " +
  "bag ball bank bar base basic basis bear beat beautiful bed begin behavior behind believe benefit best better beyond big " +
  "bill bit black block blood blue board boat body book born borrow boss bottom box boy brain branch brand bread break " +
  "bring broad brother brown budget build building business busy buy call calm camera campaign capital car card care " +
  "career carry case cash cat catch cause cell center central century certain chair challenge chance change channel " +
  "chapter character charge cheap check chicken chief child choice choose church circle citizen city claim class clean " +
  "clear climb clock close cloud club coach coast coffee cold collect college color come comfort comment common community " +
  "company compare complete computer concern condition conference consider contain content context continue control cook " +
  "cool copy corner correct cost count country couple course court cover create crime cross crowd culture cup current " +
  "customer cut daily damage danger dark data date daughter day dead deal dear death debate decade decide decision deep " +
  "defense define definition degree deliver demand deny department depend describe design despite detail determine " +
  "develop development die difference different difficult dinner direct direction director discover discuss disease " +
  "display distance divide doctor document dog door double doubt draw dream dress drink drive drop drug dry due early earn " +
  "earth easy eat economy edge edition education effect effort egg eight either election employee enable end enemy energy " +
  "engine enjoy enough enter entire environment equal error escape especially establish evening event evidence exact " +
  "example except exist expect experience expert explain express extra eye face fact factor fail fall false family famous " +
  "far farm fast father fault fear feature feel field fight figure fill film final find fine finger finish fire firm " +
  "first fish fit five fix flat floor fly focus follow food foot force foreign forget form former forward four free friend " +
  "front full fun function future game garden gas general generation girl give glass global goal good government great " +
  "green ground group grow growth guarantee guess gun guy hair half hall hand handle hang happen happy hard hate head " +
  "health hear heart heat heavy help high history hit hold hole home hope horse hospital hot hotel hour house huge human " +
  "hundred hurt husband idea identify image imagine impact important improve include increase indeed indicate individual " +
  "industry information inside instead interest international interview introduce issue item job join joke judge jump " +
  "keep key kid kill kind king kitchen know knowledge lack lady land language large last late later laugh law lay lead " +
  "leader learn least leave left leg legal less lesson letter level lie life light likely limit line list listen little " +
  "live local long look lose loss lot love low machine main maintain major manage manager many market marry match material " +
  "matter maybe mean measure media medical meet meeting member memory mention message method middle mind minute miss model " +
  "modern moment money month morning mother move movie music name nation national natural nature near nearly necessary " +
  "network never new news newspaper next nice night nine none normal north note nothing notice number occur offer office " +
  "officer official often oil old one open operation opinion option order organization original others outside page pain " +
  "paper parent part particular partner party pass past patient pattern pay peace people perfect perform perhaps period " +
  "person personal phone physical pick picture piece place plain plan plant play player point police policy political poor " +
  "popular population position positive possible power practice prepare present president pressure pretty prevent price " +
  "private probably problem process produce product production professional program project property protect prove " +
  "provide public pull purpose push put quality question quick quite race radio raise range rate rather reach read ready " +
  "real reality realize really reason receive recent recognize record red reduce reflect region relate relationship " +
  "release remain remember remove report represent require research resource respond response rest result return reveal " +
  "rich right rise risk road rock role room rule run safe sale save say scene school science score sea season seat second " +
  "section security see seek seem sell send sense series serious serve service set seven several shake share shoot short " +
  "shot show side sign significant similar simple simply since sing single sister sit site situation six size skill skin " +
  "small smile social society soldier somebody someone something sometimes son song soon sort sound source south space " +
  "speak special specific speech spend sport spring staff stage stand standard star start state statement station stay " +
  "step stock stop store story strategy street strong structure student study stuff style subject success successful " +
  "sudden suffer suggest summer support sure surface system table take talk task tax teach teacher team technology " +
  "television tell ten tend term test thank theory think third thought thousand threat three throw thus time today " +
  "together tonight top total tough toward town trade traditional training travel treat treatment tree trial trip trouble " +
  "true truth try turn two type understand unit unless unlike upon usual value various view village visit voice vote wait " +
  "walk wall war watch water weapon wear week weight well west white whole wide wife win wind window wish woman wonder word " +
  "work worker world worry write wrong yard yeah year yes young zero " +
  "anymore broken built difference ever explain fine happen hello help hey hi idea instead issue okay ok sorry still thanks " +
  "tell tried true understand wonder";

const PROGRAMMING =
  "api app application argument array async attribute await backend binary bind binding boolean bool browser buffer bug " +
  "builtin byte cache callback checkout cli client clone code command commit compile compiler component config " +
  "configuration connect connection console constant container cookie core crash database debug declare default delete " +
  "dependency deploy deployment dev developer device directory disable doc docs documentation download element empty " +
  "enabled entry exception execute exit export expression extension fetch file filter flag folder format framework " +
  "frontend hash header heap host import index input insert insertion install installation instance integer interface " +
  "iterator js keyword lib library link lint load log login loop merge mode module namespace null object output package " +
  "parameter parse path patch plugin pointer port print project property protocol proxy py query queue reference remote " +
  "repo repository request resolution resolve restore root route row runtime schema scope script search server session " +
  "setting setup shell src stack status storage stream string struct switch syntax tag target template terminal text " +
  "thread token tool ts update upgrade url user usr variable version warning workflow traceback";

export const COMMON_WORDS: readonly string[] = `${ENGLISH} ${PROGRAMMING}`.split(" ");
