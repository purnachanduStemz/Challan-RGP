// Indian states & union territories with their GST state codes, plus
// helpers to detect a state from a free-text address. Used to auto-fill
// consignee_state / consignee_state_code when a preparer types an address
// (Requirement: "Based on the Address the State Should Auto Generate", and
// "if i enter any kind of District it should identify the State correctly
// according to their District").
//
// This is a best-effort text match, not a postal/PIN-code lookup. Matching
// is done in two tiers, in order:
//   1. Does the address contain a state/UT name (or a common alias)?
//   2. If not, does it contain a district (or a well-known city/former name)
//      that belongs to exactly one state?
// It only FILLS BLANK state fields; it never overrides a state the user (or
// an earlier edit) already set explicitly. All matches are anchored to word
// boundaries (see detectStateFromAddress below) so short tokens like "UP" or
// district names that are substrings of common words don't misfire.
//
// Coverage note: district boundaries in India change periodically (e.g.
// Telangana went from 10 to 33 districts in 2016, Andhra Pradesh split out
// 13 new districts in 2022). This list reflects a recent, reasonably
// complete official district set per state, plus a handful of well-known
// former city names (Bombay, Madras, Calcutta, Trivandrum, etc.) and split
// metro sub-regions (Bengaluru Urban/Rural, Mumbai City/Suburban). It is not
// guaranteed to include the very newest district splits — if a district is
// missing, the address will just fall through with no state detected rather
// than guessing wrong, and the State field can still be typed manually.

const STATES = [
  { name: 'Jammu and Kashmir', code: '01', aliases: ['J&K', 'Jammu & Kashmir'] },
  { name: 'Himachal Pradesh', code: '02', aliases: ['HP'] },
  { name: 'Punjab', code: '03' },
  { name: 'Chandigarh', code: '04' },
  { name: 'Uttarakhand', code: '05', aliases: ['Uttaranchal'] },
  { name: 'Haryana', code: '06' },
  { name: 'Delhi', code: '07', aliases: ['NCT of Delhi', 'New Delhi'] },
  { name: 'Rajasthan', code: '08' },
  { name: 'Uttar Pradesh', code: '09', aliases: ['UP'] },
  { name: 'Bihar', code: '10' },
  { name: 'Sikkim', code: '11' },
  { name: 'Arunachal Pradesh', code: '12' },
  { name: 'Nagaland', code: '13' },
  { name: 'Manipur', code: '14' },
  { name: 'Mizoram', code: '15' },
  { name: 'Tripura', code: '16' },
  { name: 'Meghalaya', code: '17' },
  { name: 'Assam', code: '18' },
  { name: 'West Bengal', code: '19' },
  { name: 'Jharkhand', code: '20' },
  { name: 'Odisha', code: '21', aliases: ['Orissa'] },
  { name: 'Chhattisgarh', code: '22', aliases: ['Chattisgarh'] },
  { name: 'Madhya Pradesh', code: '23', aliases: ['MP'] },
  { name: 'Gujarat', code: '24' },
  { name: 'Dadra and Nagar Haveli and Daman and Diu', code: '26', aliases: ['Daman and Diu', 'Dadra and Nagar Haveli'] },
  { name: 'Maharashtra', code: '27' },
  { name: 'Karnataka', code: '29', aliases: ['Karnatka', 'Bengaluru', 'Bangalore'] },
  { name: 'Goa', code: '30' },
  { name: 'Lakshadweep', code: '31' },
  { name: 'Kerala', code: '32' },
  { name: 'Tamil Nadu', code: '33', aliases: ['TN'] },
  { name: 'Puducherry', code: '34', aliases: ['Pondicherry'] },
  { name: 'Andaman and Nicobar Islands', code: '35' },
  { name: 'Telangana', code: '36' },
  { name: 'Andhra Pradesh', code: '37' },
  { name: 'Ladakh', code: '38' }
];

const STATE_BY_NAME = new Map(STATES.map((s) => [s.name, s]));

// district/city/former-name (lowercase) -> state name (must match a `name`
// in STATES above exactly). Grouped by state purely for readability.
const DISTRICT_TO_STATE = {};
function addDistricts(stateName, districts) {
  for (const d of districts) {
    DISTRICT_TO_STATE[d.toLowerCase()] = stateName;
  }
}

addDistricts('Andhra Pradesh', [
  'Srikakulam', 'Parvathipuram Manyam', 'Vizianagaram', 'Visakhapatnam', 'Alluri Sitharama Raju',
  'Anakapalli', 'Kakinada', 'East Godavari', 'Konaseema', 'West Godavari', 'Eluru', 'Krishna',
  'NTR', 'Guntur', 'Palnadu', 'Bapatla', 'Prakasam', 'Nellore', 'SPSR Nellore', 'Kurnool',
  'Nandyal', 'Anantapur', 'Sri Sathya Sai', 'YSR Kadapa', 'Kadapa', 'Annamayya', 'Chittoor', 'Tirupati'
]);

addDistricts('Telangana', [
  'Adilabad', 'Bhadradri Kothagudem', 'Hanamkonda', 'Hyderabad', 'Jagtial', 'Jangaon',
  'Jayashankar Bhupalpally', 'Jogulamba Gadwal', 'Kamareddy', 'Karimnagar', 'Khammam',
  'Komaram Bheem', 'Mahabubabad', 'Mahabubnagar', 'Mancherial', 'Medak', 'Medchal-Malkajgiri',
  'Medchal', 'Mulugu', 'Nagarkurnool', 'Nalgonda', 'Narayanpet', 'Nirmal', 'Nizamabad',
  'Peddapalli', 'Rajanna Sircilla', 'Rangareddy', 'Sangareddy', 'Siddipet', 'Suryapet',
  'Vikarabad', 'Wanaparthy', 'Warangal', 'Yadadri Bhuvanagiri', 'Secunderabad'
]);

addDistricts('Karnataka', [
  'Bagalkot', 'Ballari', 'Bellary', 'Belagavi', 'Belgaum', 'Bengaluru Urban', 'Bengaluru Rural',
  'Bidar', 'Chamarajanagar', 'Chikballapur', 'Chikkaballapur', 'Chikkamagaluru', 'Chikmagalur',
  'Chitradurga', 'Dakshina Kannada', 'Mangalore', 'Mangaluru', 'Davanagere', 'Dharwad', 'Gadag',
  'Hassan', 'Haveri', 'Kalaburagi', 'Gulbarga', 'Kodagu', 'Coorg', 'Kolar', 'Koppal', 'Mandya',
  'Mysuru', 'Mysore', 'Raichur', 'Ramanagara', 'Shivamogga', 'Shimoga', 'Tumakuru', 'Tumkur',
  'Udupi', 'Uttara Kannada', 'Karwar', 'Vijayapura', 'Bijapur', 'Yadgir', 'Vijayanagara'
]);

addDistricts('Tamil Nadu', [
  'Ariyalur', 'Chengalpattu', 'Chennai', 'Madras', 'Coimbatore', 'Cuddalore', 'Dharmapuri',
  'Dindigul', 'Erode', 'Kallakurichi', 'Kanchipuram', 'Kanyakumari', 'Karur', 'Krishnagiri',
  'Madurai', 'Mayiladuthurai', 'Nagapattinam', 'Namakkal', 'Nilgiris', 'Ooty', 'Perambalur',
  'Pudukkottai', 'Ramanathapuram', 'Ranipet', 'Salem', 'Sivaganga', 'Tenkasi', 'Thanjavur',
  'Theni', 'Thoothukudi', 'Tuticorin', 'Tiruchirappalli', 'Trichy', 'Tirunelveli', 'Tirupathur',
  'Tiruppur', 'Tirupur', 'Tiruvallur', 'Tiruvannamalai', 'Tiruvarur', 'Vellore', 'Viluppuram',
  'Villupuram', 'Virudhunagar'
]);

addDistricts('Kerala', [
  'Alappuzha', 'Alleppey', 'Ernakulam', 'Idukki', 'Kannur', 'Cannanore', 'Kasaragod', 'Kollam',
  'Quilon', 'Kottayam', 'Kozhikode', 'Calicut', 'Malappuram', 'Palakkad', 'Palghat',
  'Pathanamthitta', 'Thiruvananthapuram', 'Trivandrum', 'Thrissur', 'Trichur', 'Wayanad'
]);

addDistricts('Maharashtra', [
  'Ahmednagar', 'Ahilyanagar', 'Akola', 'Amravati', 'Aurangabad', 'Chhatrapati Sambhajinagar',
  'Beed', 'Bhandara', 'Buldhana', 'Chandrapur', 'Dhule', 'Gadchiroli', 'Gondia', 'Hingoli',
  'Jalgaon', 'Jalna', 'Kolhapur', 'Latur', 'Mumbai City', 'Mumbai Suburban', 'Mumbai', 'Bombay',
  'Nagpur', 'Nanded', 'Nandurbar', 'Nashik', 'Nasik', 'Osmanabad', 'Dharashiv', 'Palghar',
  'Parbhani', 'Pune', 'Poona', 'Raigad', 'Ratnagiri', 'Sangli', 'Satara', 'Sindhudurg', 'Solapur',
  'Thane', 'Wardha', 'Washim', 'Yavatmal'
]);

addDistricts('Gujarat', [
  'Ahmedabad', 'Amreli', 'Anand', 'Aravalli', 'Banaskantha', 'Bharuch', 'Bhavnagar', 'Botad',
  'Chhota Udepur', 'Dahod', 'Dang', 'Devbhoomi Dwarka', 'Gandhinagar', 'Gir Somnath', 'Jamnagar',
  'Junagadh', 'Kheda', 'Kutch', 'Kachchh', 'Mahisagar', 'Mehsana', 'Morbi', 'Narmada', 'Navsari',
  'Panchmahal', 'Patan', 'Porbandar', 'Rajkot', 'Sabarkantha', 'Surat', 'Surendranagar', 'Tapi',
  'Vadodara', 'Baroda', 'Valsad'
]);

addDistricts('Rajasthan', [
  'Ajmer', 'Alwar', 'Banswara', 'Baran', 'Barmer', 'Bharatpur', 'Bhilwara', 'Bikaner', 'Bundi',
  'Chittorgarh', 'Churu', 'Dausa', 'Dholpur', 'Dungarpur', 'Hanumangarh', 'Jaipur', 'Jaisalmer',
  'Jalore', 'Jhalawar', 'Jhunjhunu', 'Jodhpur', 'Karauli', 'Kota', 'Nagaur', 'Pali', 'Pratapgarh',
  'Rajsamand', 'Sawai Madhopur', 'Sikar', 'Sirohi', 'Sri Ganganagar', 'Ganganagar', 'Tonk',
  'Udaipur'
]);

addDistricts('Madhya Pradesh', [
  'Agar Malwa', 'Alirajpur', 'Anuppur', 'Ashoknagar', 'Balaghat', 'Barwani', 'Betul', 'Bhind',
  'Bhopal', 'Burhanpur', 'Chhatarpur', 'Chhindwara', 'Damoh', 'Datia', 'Dewas', 'Dhar', 'Dindori',
  'Guna', 'Gwalior', 'Harda', 'Hoshangabad', 'Narmadapuram', 'Indore', 'Jabalpur', 'Jhabua',
  'Katni', 'Khandwa', 'Khargone', 'Mandla', 'Mandsaur', 'Morena', 'Narsinghpur', 'Neemuch',
  'Niwari', 'Panna', 'Raisen', 'Rajgarh', 'Ratlam', 'Rewa', 'Sagar', 'Satna', 'Sehore', 'Seoni',
  'Shahdol', 'Shajapur', 'Sheopur', 'Shivpuri', 'Sidhi', 'Singrauli', 'Tikamgarh', 'Ujjain',
  'Umaria', 'Vidisha'
]);

addDistricts('Chhattisgarh', [
  'Balod', 'Baloda Bazar', 'Balrampur', 'Bastar', 'Bemetara', 'Bijapur', 'Bilaspur', 'Dantewada',
  'Dhamtari', 'Durg', 'Gariaband', 'Gaurela-Pendra-Marwahi', 'Janjgir-Champa', 'Jashpur',
  'Kabirdham', 'Kawardha', 'Kanker', 'Kondagaon', 'Korba', 'Korea', 'Koriya', 'Mahasamund',
  'Mungeli', 'Narayanpur', 'Raigarh', 'Raipur', 'Rajnandgaon', 'Sukma', 'Surajpur', 'Surguja'
]);

addDistricts('Uttar Pradesh', [
  'Agra', 'Aligarh', 'Ambedkar Nagar', 'Amethi', 'Amroha', 'Auraiya', 'Ayodhya', 'Faizabad',
  'Azamgarh', 'Baghpat', 'Bahraich', 'Ballia', 'Balrampur', 'Banda', 'Barabanki', 'Bareilly',
  'Basti', 'Bhadohi', 'Bijnor', 'Budaun', 'Bulandshahr', 'Chandauli', 'Chitrakoot', 'Deoria',
  'Etah', 'Etawah', 'Farrukhabad', 'Fatehpur', 'Firozabad', 'Gautam Buddha Nagar', 'Noida',
  'Ghaziabad', 'Ghazipur', 'Gonda', 'Gorakhpur', 'Hamirpur', 'Hapur', 'Hardoi', 'Hathras',
  'Jalaun', 'Jaunpur', 'Jhansi', 'Kannauj', 'Kanpur Dehat', 'Kanpur Nagar', 'Kanpur', 'Kasganj',
  'Kaushambi', 'Kushinagar', 'Lakhimpur Kheri', 'Lalitpur', 'Lucknow', 'Maharajganj', 'Mahoba',
  'Mainpuri', 'Mathura', 'Mau', 'Meerut', 'Mirzapur', 'Moradabad', 'Muzaffarnagar', 'Pilibhit',
  'Pratapgarh', 'Prayagraj', 'Allahabad', 'Raebareli', 'Rampur', 'Saharanpur', 'Sambhal',
  'Sant Kabir Nagar', 'Shahjahanpur', 'Shamli', 'Shravasti', 'Siddharthnagar', 'Sitapur',
  'Sonbhadra', 'Sultanpur', 'Unnao', 'Varanasi', 'Benares'
]);

addDistricts('Bihar', [
  'Araria', 'Arwal', 'Aurangabad', 'Banka', 'Begusarai', 'Bhagalpur', 'Bhojpur', 'Buxar',
  'Darbhanga', 'East Champaran', 'Motihari', 'Gaya', 'Gopalganj', 'Jamui', 'Jehanabad', 'Kaimur',
  'Bhabua', 'Katihar', 'Khagaria', 'Kishanganj', 'Lakhisarai', 'Madhepura', 'Madhubani', 'Munger',
  'Muzaffarpur', 'Nalanda', 'Nawada', 'Patna', 'Purnia', 'Rohtas', 'Saharsa', 'Samastipur',
  'Saran', 'Sheikhpura', 'Sheohar', 'Sitamarhi', 'Siwan', 'Supaul', 'Vaishali', 'West Champaran',
  'Bettiah'
]);

addDistricts('Jharkhand', [
  'Bokaro', 'Chatra', 'Deoghar', 'Dhanbad', 'Dumka', 'East Singhbhum', 'Jamshedpur', 'Garhwa',
  'Giridih', 'Godda', 'Gumla', 'Hazaribagh', 'Jamtara', 'Khunti', 'Koderma', 'Latehar',
  'Lohardaga', 'Pakur', 'Palamu', 'Ramgarh', 'Ranchi', 'Sahibganj', 'Seraikela Kharsawan',
  'Simdega', 'West Singhbhum'
]);

addDistricts('West Bengal', [
  'Alipurduar', 'Bankura', 'Birbhum', 'Cooch Behar', 'Dakshin Dinajpur', 'Darjeeling', 'Hooghly',
  'Howrah', 'Jalpaiguri', 'Jhargram', 'Kalimpong', 'Kolkata', 'Calcutta', 'Malda', 'Murshidabad',
  'Nadia', 'North 24 Parganas', 'Paschim Bardhaman', 'Paschim Medinipur', 'Purba Bardhaman',
  'Purba Medinipur', 'Purulia', 'South 24 Parganas', 'Uttar Dinajpur'
]);

addDistricts('Odisha', [
  'Angul', 'Balangir', 'Bolangir', 'Balasore', 'Bargarh', 'Bhadrak', 'Boudh', 'Cuttack',
  'Deogarh', 'Dhenkanal', 'Gajapati', 'Ganjam', 'Jagatsinghpur', 'Jajpur', 'Jharsuguda',
  'Kalahandi', 'Kandhamal', 'Kendrapara', 'Kendujhar', 'Keonjhar', 'Khordha', 'Bhubaneswar',
  'Koraput', 'Malkangiri', 'Mayurbhanj', 'Nabarangpur', 'Nayagarh', 'Nuapada', 'Puri', 'Rayagada',
  'Sambalpur', 'Subarnapur', 'Sonepur', 'Sundargarh'
]);

addDistricts('Assam', [
  'Baksa', 'Barpeta', 'Biswanath', 'Bongaigaon', 'Cachar', 'Silchar', 'Charaideo', 'Chirang',
  'Darrang', 'Dhemaji', 'Dhubri', 'Dibrugarh', 'Dima Hasao', 'Goalpara', 'Golaghat', 'Hailakandi',
  'Hojai', 'Jorhat', 'Kamrup', 'Kamrup Metropolitan', 'Guwahati', 'Karbi Anglong', 'Karimganj',
  'Kokrajhar', 'Lakhimpur', 'Majuli', 'Morigaon', 'Nagaon', 'Nalbari', 'Sivasagar', 'Sonitpur',
  'Tezpur', 'South Salmara-Mankachar', 'Tinsukia', 'Udalguri', 'West Karbi Anglong'
]);

addDistricts('Punjab', [
  'Amritsar', 'Barnala', 'Bathinda', 'Faridkot', 'Fatehgarh Sahib', 'Fazilka', 'Ferozepur',
  'Gurdaspur', 'Hoshiarpur', 'Jalandhar', 'Kapurthala', 'Ludhiana', 'Mansa', 'Moga', 'Muktsar',
  'Pathankot', 'Patiala', 'Rupnagar', 'Ropar', 'Mohali', 'Sahibzada Ajit Singh Nagar', 'Sangrur',
  'Shaheed Bhagat Singh Nagar', 'Nawanshahr', 'Tarn Taran'
]);

addDistricts('Haryana', [
  'Ambala', 'Bhiwani', 'Charkhi Dadri', 'Faridabad', 'Fatehabad', 'Gurugram', 'Gurgaon', 'Hisar',
  'Jhajjar', 'Jind', 'Kaithal', 'Karnal', 'Kurukshetra', 'Mahendragarh', 'Nuh', 'Mewat', 'Palwal',
  'Panchkula', 'Panipat', 'Rewari', 'Rohtak', 'Sirsa', 'Sonipat', 'Yamunanagar'
]);

addDistricts('Himachal Pradesh', [
  'Bilaspur', 'Chamba', 'Hamirpur', 'Kangra', 'Kinnaur', 'Kullu', 'Lahaul and Spiti', 'Mandi',
  'Shimla', 'Sirmaur', 'Solan', 'Una'
]);

addDistricts('Uttarakhand', [
  'Almora', 'Bageshwar', 'Chamoli', 'Champawat', 'Dehradun', 'Haridwar', 'Nainital',
  'Pauri Garhwal', 'Pithoragarh', 'Rudraprayag', 'Tehri Garhwal', 'Udham Singh Nagar',
  'Uttarkashi'
]);

addDistricts('Jammu and Kashmir', [
  'Anantnag', 'Bandipora', 'Baramulla', 'Budgam', 'Doda', 'Ganderbal', 'Jammu', 'Kathua',
  'Kishtwar', 'Kulgam', 'Kupwara', 'Poonch', 'Pulwama', 'Rajouri', 'Ramban', 'Reasi', 'Samba',
  'Shopian', 'Srinagar', 'Udhampur'
]);

addDistricts('Ladakh', ['Kargil', 'Leh']);

addDistricts('Goa', ['North Goa', 'South Goa', 'Panaji', 'Panjim', 'Margao']);

addDistricts('Manipur', [
  'Bishnupur', 'Chandel', 'Churachandpur', 'Imphal East', 'Imphal West', 'Jiribam', 'Kakching',
  'Kamjong', 'Kangpokpi', 'Noney', 'Pherzawl', 'Senapati', 'Tamenglong', 'Tengnoupal', 'Thoubal',
  'Ukhrul'
]);

addDistricts('Meghalaya', [
  'East Garo Hills', 'East Jaintia Hills', 'East Khasi Hills', 'Shillong', 'North Garo Hills',
  'Ri Bhoi', 'South Garo Hills', 'South West Garo Hills', 'South West Khasi Hills',
  'West Garo Hills', 'West Jaintia Hills', 'West Khasi Hills'
]);

addDistricts('Mizoram', [
  'Aizawl', 'Champhai', 'Hnahthial', 'Khawzawl', 'Kolasib', 'Lawngtlai', 'Lunglei', 'Mamit',
  'Saitual', 'Serchhip', 'Siaha'
]);

addDistricts('Nagaland', [
  'Chumoukedima', 'Dimapur', 'Kiphire', 'Kohima', 'Longleng', 'Mokokchung', 'Mon', 'Niuland',
  'Noklak', 'Peren', 'Phek', 'Shamator', 'Tseminyu', 'Tuensang', 'Wokha', 'Zunheboto'
]);

addDistricts('Tripura', [
  'Dhalai', 'Gomati', 'Khowai', 'North Tripura', 'Sepahijala', 'South Tripura', 'Unakoti',
  'West Tripura', 'Agartala'
]);

addDistricts('Sikkim', [
  'East Sikkim', 'Gangtok', 'North Sikkim', 'Mangan', 'South Sikkim', 'Namchi', 'West Sikkim',
  'Gyalshing', 'Pakyong', 'Soreng'
]);

addDistricts('Arunachal Pradesh', [
  'Anjaw', 'Changlang', 'Dibang Valley', 'East Kameng', 'East Siang', 'Kamle', 'Kra Daadi',
  'Kurung Kumey', 'Lepa Rada', 'Lohit', 'Longding', 'Lower Dibang Valley', 'Lower Siang',
  'Lower Subansiri', 'Namsai', 'Pakke Kessang', 'Papum Pare', 'Itanagar', 'Shi Yomi', 'Siang',
  'Tawang', 'Tirap', 'Upper Siang', 'Upper Subansiri', 'West Kameng', 'West Siang'
]);

addDistricts('Delhi', [
  'Central Delhi', 'East Delhi', 'New Delhi', 'North Delhi', 'North East Delhi',
  'North West Delhi', 'Shahdara', 'South Delhi', 'South East Delhi', 'South West Delhi',
  'West Delhi'
]);

addDistricts('Chandigarh', ['Chandigarh']);

addDistricts('Puducherry', ['Puducherry', 'Pondicherry', 'Karaikal', 'Mahe', 'Yanam']);

addDistricts('Andaman and Nicobar Islands', [
  'Nicobar', 'North and Middle Andaman', 'South Andaman', 'Port Blair'
]);

addDistricts('Lakshadweep', ['Lakshadweep', 'Kavaratti']);

addDistricts('Dadra and Nagar Haveli and Daman and Diu', [
  'Dadra and Nagar Haveli', 'Daman', 'Diu'
]);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Precompiled once at module load (not per-call) — with ~700 district
// entries, building a fresh RegExp for every candidate on every keystroke/
// request would be wasteful. Longer candidates are checked first so the
// "best (longest) match" logic can short-circuit-ish without re-sorting
// results per call.
const STATE_MATCHERS = STATES
  .flatMap((state) => [state.name, ...(state.aliases || [])].map((candidate) => ({
    state,
    candidate,
    regex: new RegExp(`\\b${escapeRegex(candidate)}\\b`, 'i')
  })))
  .sort((a, b) => b.candidate.length - a.candidate.length);

const DISTRICT_MATCHERS = Object.keys(DISTRICT_TO_STATE)
  .map((district) => ({
    district,
    stateName: DISTRICT_TO_STATE[district],
    regex: new RegExp(`\\b${escapeRegex(district)}\\b`, 'i')
  }))
  .sort((a, b) => b.district.length - a.district.length);

/**
 * Scan free-text `address` in two tiers and return the best match, or null:
 *   1. A state/UT name or alias appearing in the address (most authoritative
 *      — if the address literally says the state, trust it).
 *   2. Otherwise, a district (or well-known city/former name) that maps to
 *      exactly one state — this is the common case, since most addresses
 *      name a city/district rather than spelling out the state.
 *
 * Matches are anchored to word boundaries (`\b...\b`), NOT plain substring
 * search — see the module comment above for why that matters (short tokens
 * like "UP"/"MP" otherwise match inside ordinary words like "Group"/
 * "Complex"). Matchers are sorted longest-first, so the first hit in each
 * tier is already the best (most specific) one for that tier.
 *
 * @param {string} address
 * @returns {{name: string, code: string} | null}
 */
function detectStateFromAddress(address) {
  if (!address) return null;
  const text = String(address);

  // Tier 1: explicit state name/alias.
  const stateHit = STATE_MATCHERS.find((m) => m.regex.test(text));
  if (stateHit) return { name: stateHit.state.name, code: stateHit.state.code };

  // Tier 2: district / city / former name -> state.
  const districtHit = DISTRICT_MATCHERS.find((m) => m.regex.test(text));
  if (districtHit) {
    const state = STATE_BY_NAME.get(districtHit.stateName);
    if (state) return { name: state.name, code: state.code };
  }

  return null;
}

function detectDistrictFromAddress(address) {
  if (!address) return null;
  const text = String(address);
  const districtHit = DISTRICT_MATCHERS.find((m) => m.regex.test(text));
  return districtHit ? districtHit.district : null;
}

/**
 * Resolve the GST state code for an exact state name/alias (case-insensitive).
 * Used when only `consignee_state` is available (e.g. typed directly, since
 * the State Code field was removed from the form) and we still need to
 * store the matching code for the GST-required "State & State Code" line.
 * @param {string} name
 * @returns {string | null}
 */
function getStateCodeByName(name) {
  if (!name) return null;
  const normalized = String(name).trim().toLowerCase();
  for (const state of STATES) {
    const candidates = [state.name, ...(state.aliases || [])];
    if (candidates.some((c) => c.toLowerCase() === normalized)) {
      return state.code;
    }
  }
  return null;
}

module.exports = {
  STATES,
  DISTRICT_TO_STATE,
  detectStateFromAddress,
  detectDistrictFromAddress,
  getStateCodeByName
};
