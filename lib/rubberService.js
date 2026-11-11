/**
 * Rubber Leaf Doctor — AI analysis service
 * วิเคราะห์ธาตุอาหาร โรค และความผิดปกติของยางพาราจากภาพใบและหน้ากรีด
 *
 * ความรู้อ้างอิงในคำสั่ง AI ด้านล่างเป็น "ร่าง" จากหลักวิชาการทั่วไป
 * ต้องให้ทีมนักวิชาการสมาร์ทกรีนตรวจทานก่อนใช้งานจริง
 */
import { isBusyError, BUSY_MESSAGE_TH } from './modelRetry.js';
import { generateJsonWithFallback, normalizeSmartGreenProductText } from './gemini.js';
import { getEnabledRubberProducts, matchRubberProduct } from './rubberProducts.js';

// ตำแหน่งภาพที่รับ (3 ภาพบังคับ + 1 ภาพเสริม)
export const RUBBER_IMAGE_SLOTS = [
  { key: 'young', label: 'ใบยอด / ฉัตรใบอ่อน', required: true },
  { key: 'mature', label: 'ใบมาตรฐาน (ฉัตรล่างของกิ่งยอด ใบอายุ 3-5 เดือน)', required: true },
  { key: 'old', label: 'ใบแก่ / ใบล่างในทรงพุ่ม', required: true },
  { key: 'tree', label: 'ลำต้น / หน้ากรีด / โคนต้น (ไม่บังคับ)', required: false },
];

export const RUBBER_NUTRIENTS = [
  { code: 'N', name: 'ไนโตรเจน (N)' },
  { code: 'P', name: 'ฟอสฟอรัส (P)' },
  { code: 'K', name: 'โพแทสเซียม (K)' },
  { code: 'Mg', name: 'แมกนีเซียม (Mg)' },
  { code: 'Ca', name: 'แคลเซียม (Ca)' },
  { code: 'B', name: 'โบรอน (B)' },
  { code: 'Zn', name: 'สังกะสี (Zn)' },
  { code: 'Mn', name: 'แมงกานีส (Mn)' },
];

const STATUS_LEVELS = ['ปกติ', 'เสี่ยงขาด', 'ขาดเล็กน้อย', 'ขาดปานกลาง', 'ขาดรุนแรง', 'ต้องตรวจเพิ่ม'];
const LIKELIHOODS = ['สูง', 'ปานกลาง', 'ต่ำ'];

function buildProductSection() {
  const products = getEnabledRubberProducts();
  if (!products.length) {
    return 'ผลิตภัณฑ์สมาร์ทกรีน: ยังไม่มีรายการสำหรับยางพารา ให้ตอบ "smart_green_products": []';
  }
  const lines = products.map(p =>
    `  * ${p.name}: ${p.description} (ช่วยเรื่อง: ${p.fixes.join(', ')})${p.usage ? ` — อัตราใช้: ${p.usage}` : ''}`
  );
  return `ผลิตภัณฑ์สมาร์ทกรีน (SMART GREEN) ที่อนุญาตให้แนะนำเสริม:
${lines.join('\n')}
กติกา: แนะนำได้เฉพาะชื่อในรายการนี้ 0-3 รายการ ที่ตรงกับปัญหาที่พบจริงเท่านั้น ห้ามคิดชื่อหรือสูตรใหม่
ห้ามระบุอัตราใช้เองหากรายการไม่ได้ให้อัตราไว้ ให้เขียนว่า "ใช้ตามอัตราบนฉลาก" ผลิตภัณฑ์เหล่านี้เป็นตัวเสริม ไม่ใช่ตัวแทนแผนปุ๋ยหลัก
หากต้นสมบูรณ์ดีหรือไม่มีรายการที่ตรงปัญหา ให้ตอบ []`;
}

export function buildRubberPrompt(payload) {
  const hasTree = Boolean(payload.images && payload.images.tree);
  const observed = Array.isArray(payload.observedSymptoms) && payload.observedSymptoms.length
    ? payload.observedSymptoms.join(', ')
    : '-';

  return `
คุณคือระบบ "Vision Ai วิเคราะห์ใบยางพารา" ผู้เชี่ยวชาญด้านธาตุอาหารพืช โรคพืช และการจัดการสวนยางพารา (Hevea brasiliensis) ในประเทศไทย

ขั้นตอนที่ 1 — ตรวจสอบความถูกต้องของภาพ (บังคับ):
- ภาพต้องเป็นใบ/ฉัตรใบ/กิ่ง/ลำต้น/หน้ากรีด/โคนต้นของ "ยางพารา" (ใบประกอบ 3 ใบย่อยบนก้านใบยาว ใบรูปรีปลายแหลม ผิวมัน)
- ดูจากภาพจริงเท่านั้น ห้ามใช้ข้อมูลแปลงหรืออาการที่ผู้ใช้กรอกมาแทนภาพ ข้อมูลแปลงใช้ประกอบการวินิจฉัยหลังจากภาพผ่านการตรวจแล้วเท่านั้น
- ให้บรรยายสิ่งที่เห็นจริงในแต่ละภาพลงใน "image_checks" ก่อนเสมอ (เช่น "ใบยางสีเขียวมีจุดแผลสีน้ำตาล", "ภาพสีเขียวทึบไม่มีรายละเอียด")
- ภาพถ่ายจริงจากสวนที่เห็นใบหรือต้นยางเพียงบางส่วน หรือมีพื้นหลังรก ถือว่าผ่าน
- หากภาพใดไม่ใช่ยางพารา (เช่น คน สัตว์ สิ่งของ เอกสาร หน้าจอ ภาพวาด/ภาพกราฟิก ภาพสีพื้นทึบ ใบพืชชนิดอื่น เช่น ปาล์ม อ้อย มันสำปะหลัง) หรือมืด/เบลอจนวิเคราะห์ไม่ได้ ให้ตอบ
  "is_rubber": false และ "invalid_image_reason" ระบุอย่างสุภาพว่าภาพตำแหน่งใดไม่ถูกต้อง พร้อมแนะนำให้ถ่ายใหม่ (ฟิลด์อื่นใส่ค่าว่างได้)
- หากถูกต้องให้ตอบ "is_rubber": true, "invalid_image_reason": ""

ขั้นตอนที่ 2 — ภาพที่ได้รับ (เรียงตามลำดับ):
1) ใบยอด / ฉัตรใบอ่อน — ดูธาตุที่เคลื่อนย้ายยาก: B, Zn, Ca, Mn และโรคที่ทำลายใบอ่อน (ราแป้ง แอนแทรกโนส)
2) ใบมาตรฐาน — ใบที่โตเต็มที่ในฉัตรล่างสุดของกิ่งยอดที่อยู่ในร่มเงา อายุใบ 3-5 เดือน (ตำแหน่งมาตรฐานสำหรับเก็บใบวิเคราะห์) — ภาพตัวแทนสถานะธาตุอาหารของต้น
3) ใบแก่ / ใบล่างในทรงพุ่ม — ดูธาตุที่เคลื่อนย้ายได้: N, P, K, Mg และโรคใบร่วง/ใบจุด
${hasTree ? '4) ลำต้น / หน้ากรีด / โคนต้น — ใช้ดูอาการเปลือกแห้ง (หน้ากรีดไม่มีน้ำยาง) โรคหน้ากรีด แผลที่ลำต้น ดอกเห็ดหรือเส้นใยราที่โคน/ราก' : '(ไม่มีภาพลำต้น/หน้ากรีด ให้ระบุ tree_analysis ว่า "ไม่มีภาพ")'}

ความรู้อ้างอิงอาการขาดธาตุของยางพารา:
- N: ใบซีดเหลืองอ่อนสม่ำเสมอทั้งใบ เริ่มจากใบล่าง ใบเล็ก ทรงพุ่มโปร่ง การเจริญเติบโตช้า
- P: ใบเล็ก สีเขียวคล้ำหม่น ปลายใบและขอบใบมีสีน้ำตาลอมม่วง ต้นแคระแกร็น — มักต้องยืนยันด้วยผลวิเคราะห์
- K: ขอบใบและปลายใบเหลืองแล้วไหม้เป็นสีน้ำตาลจากขอบเข้าหาเส้นกลางใบ เริ่มที่ใบล่าง
- Mg: (พบบ่อยในดินทราย/ดินกรด หรือใส่ K มากเกินไป) ใบเหลืองระหว่างเส้นใบ เส้นใบยังเขียวเป็นลายก้างปลา เริ่มจากใบแก่ ปลายใบซีดก่อน
- Ca: ใบอ่อนขอบใบเหลืองซีด ปลายใบแห้งตาย ตายอดเสีย
- B: ใบอ่อนเล็ก บิดเบี้ยว ขอบใบหยัก ใบเปราะ ตายอดตาย แตกกิ่งมาก
- Zn: ใบอ่อนเล็กแคบ เหลืองระหว่างเส้นใบ ข้อปล้องสั้น ใบเป็นกระจุก
- Mn: ใบอ่อน/ใบกลางเหลืองซีดระหว่างเส้นใบ เส้นใบเขียวเป็นแถบกว้าง (พบในดินด่าง/ดินที่ใส่ปูนมาก)

ความรู้อ้างอิงโรคและความผิดปกติสำคัญของยางพารา:
- โรคใบร่วงไฟทอปธอรา (Phytophthora leaf fall): ใบร่วงทั้งที่ยังเขียว ก้านใบมีแผลช้ำสีดำมีหยดน้ำยาง ระบาดช่วงฝนตกชุก
- โรคใบร่วงชนิดใหม่ (Pestalotiopsis): ใบมีแผลจุดกลมสีน้ำตาลถึงเทา ขอบแผลสีเหลือง ใบเหลืองร่วงจำนวนมาก (ระบาดในภาคใต้ตั้งแต่ปี 2562)
- โรคใบจุดก้างปลา (Corynespora): แผลสีน้ำตาลมีเส้นใบสีเข้มแตกแขนงคล้ายก้างปลา ใบเหลืองร่วง
- โรคราแป้ง (Oidium): ผงสีขาวบนใบอ่อน ใบอ่อนหงิกร่วง พบช่วงผลิใบใหม่หลังผลัดใบ อากาศเย็นชื้น
- โรคใบจุดตานก (Drechslera): จุดแผลกลมเล็ก ตรงกลางสีขาวขอบสีน้ำตาลคล้ายตานก พบมากในต้นกล้า/ยางเล็ก
- โรคแอนแทรกโนส (Colletotrichum): ใบอ่อนมีแผลสีน้ำตาลดำ ขอบไม่เรียบ ปลายใบแห้ง ใบร่วง
- โรคราสีชมพู (Pink disease): เส้นใยสีขาวอมชมพูที่กิ่ง/ง่ามกิ่ง กิ่งแห้งตาย ใบเหี่ยวคากิ่ง
- โรครากขาว (Rigidoporus): ทรงพุ่มใบเหลืองซีด ใบร่วง ต้นทรุดโทรม มีดอกเห็ดสีส้มขอบขาวที่โคนต้น เส้นใยสีขาวที่ราก — ร้ายแรง ต้องแจ้งเร่งด่วน
- โรคเส้นดำ (Black stripe) / โรคเปลือกเน่า (Mouldy rot): หน้ากรีดมีรอยช้ำเป็นเส้นสีดำตามแนวดิ่ง หรือมีเชื้อราสีเทาบนรอยกรีด เปลือกเน่า — ระบาดช่วงฝน
- อาการเปลือกแห้ง (Tapping panel dryness, TPD): หน้ากรีดบางส่วนหรือทั้งหมดไม่มีน้ำยางไหล เปลือกแห้งสีน้ำตาล อาจแตก — มักเกิดจากกรีดถี่/ใช้สารเร่งน้ำยางมากเกิน ไม่ใช่โรคติดเชื้อ
- แมลงและสัตว์: ไรแดง (ใบสีบรอนซ์ซีด), เพลี้ยแป้ง/เพลี้ยหอย (ใบหงิก มีราดำ), ปลวกกินราก/ลำต้น, หนอนทรายกินราก (ยางเล็ก)
- ความเครียดจากภาวะแล้ง: ใบเหลืองร่วงก่อนฤดูผลัดใบ ทรงพุ่มโปร่ง น้ำยางน้อย — ต้องแยกจากการผลัดใบตามธรรมชาติ (ม.ค.-มี.ค.) และโรครากขาว (แล้งมักเป็นทั้งแปลงพร้อมกัน ไม่มีดอกเห็ด)

${buildProductSection()}

ข้อมูลแปลงจากผู้ใช้:
- ชื่อเกษตรกร / แปลง: ${payload.customerName || '-'}
- ผู้ตรวจ / ผู้ดูแล: ${payload.inspectorName || '-'}
- อายุต้นยาง: ${payload.treeAge || '-'} ปี
- สถานะการกรีด: ${payload.tappingStatus || '-'}
- พันธุ์ยาง: ${payload.variety || '-'}
- จังหวัด: ${payload.province || '-'}
- พิกัดแปลง (GPS): ${payload.coordinates || '-'}
- ชนิดดิน: ${payload.soilType || '-'}
- สภาพน้ำ/ความชื้น: ${payload.waterStatus || '-'}
- ค่า pH ดิน: ${payload.soilPh || 'ไม่ได้วัด'}
- ผลผลิตยางแห้งปัจจุบัน: ${payload.yieldPerRai || '-'} กก./ไร่/ปี
- ปุ๋ยที่ใส่ล่าสุด: ${payload.lastFertilizer || '-'}
- อาการที่ผู้ใช้สังเกตเห็นในแปลง: ${observed}
- หมายเหตุเพิ่มเติม: ${payload.notes || '-'}

กติกาการวิเคราะห์:
1. ห้ามฟันธงจากภาพอย่างเดียว ใช้ความต่างระหว่างใบยอด / ใบมาตรฐาน / ใบแก่ และข้อมูลแปลงประกอบ
2. แยกอาการขาดธาตุ ออกจากโรค แมลง ความเครียดน้ำ การผลัดใบตามฤดูกาล และอาการจากสารเคมีให้ชัดเจน
3. หากไม่มั่นใจ ให้ระบุสถานะ "ต้องตรวจเพิ่ม" และแนะนำวิธีตรวจ (เก็บใบมาตรฐานส่งวิเคราะห์ห้องแล็บ ช่วง ส.ค.-ต.ค. / ตรวจดิน)
4. ต้องประเมินธาตุครบทั้ง 8 ตัว: N, P, K, Mg, Ca, B, Zn, Mn โดยสถานะเลือกจาก: ${STATUS_LEVELS.join(' | ')}
5. ภาษาไทย อ่านง่าย ใช้ได้จริงสำหรับเกษตรกร
6. ตอบเป็น JSON เท่านั้น

แนวทางคำแนะนำปุ๋ย (ปรับตามอายุ ชนิดดิน และผลวิเคราะห์ดิน/ใบ):
- ยางก่อนเปิดกรีด: สูตร 20-8-20 (ดินร่วนทราย) หรือ 20-10-12 (ดินร่วนเหนียว) อัตราเพิ่มตามอายุ ประมาณ 0.1-0.6 กก./ต้น/ครั้ง แบ่งใส่ 2 ครั้ง/ปี
- ยางเปิดกรีดแล้ว: สูตร 30-5-18 (หรือสูตรใกล้เคียง) ประมาณ 1 กก./ต้น/ปี แบ่งใส่ 2 ครั้ง ต้นฤดูฝนและปลายฤดูฝน
- แมกนีเซียม: กีเซอร์ไรท์ (MgSO4) 0.2-0.5 กก./ต้น/ปี หรือโดโลไมท์ในดินกรด
- จุลธาตุ (B, Zn, Mn): พ่นทางใบแบบคีเลตตามอัตราบนฉลากในช่วงผลิใบใหม่ / ใส่ทางดินปริมาณน้อย (โบแรกซ์ไม่เกิน 20-30 กรัม/ต้น/ปี)
- วิธีใส่: หว่านในแถวยางห่างโคนต้น 1-1.5 ม. หรือในแนวทรงพุ่ม กำจัดวัชพืชก่อนใส่ ใส่ตอนดินชื้น ห้ามใส่ขณะดินแห้ง
- ช่วงผลัดใบ/ผลิใบใหม่ (ม.ค.-มี.ค.): งดหรือลดการกรีดตามคำแนะนำ เฝ้าระวังโรคราแป้ง
- หน้ากรีดมีปัญหา: แนะนำหยุดกรีด/ลดความถี่กรีด ลดสารเร่งน้ำยาง ทาสารป้องกันเชื้อราหน้ากรีดในฤดูฝน
- ดินกรดจัด pH < 4.5: แนะนำโดโลไมท์ปรับดิน

ให้ตอบเป็น JSON โครงสร้างนี้เท่านั้น:
{
  "image_checks": [
    { "slot": "young", "is_rubber": true, "seen": "สิ่งที่เห็นจริงในภาพนี้ 1 ประโยค" }
  ],
  "is_rubber": true,
  "invalid_image_reason": "",
  "young_leaf_analysis": "สรุปอาการใบยอด/ฉัตรใบอ่อน 1-2 ประโยค",
  "mature_leaf_analysis": "สรุปอาการใบมาตรฐาน 1-2 ประโยค",
  "old_leaf_analysis": "สรุปอาการใบแก่ 1-2 ประโยค",
  "tree_analysis": "สรุปจากภาพลำต้น/หน้ากรีด/โคนต้น หรือ 'ไม่มีภาพ'",
  "health_score": 75,
  "primary_issue": "ปัญหาหลักสั้นๆ เช่น ขาดแมกนีเซียม (Mg) ระดับปานกลาง",
  "overall_summary": "สรุปภาพรวม 2-4 ประโยค ข้อสันนิษฐานและเหตุผล",
  "nutrient_status": [
    { "code": "N", "status": "ปกติ", "evidence": "เหตุผล/อาการที่เห็นสั้นๆ" }
  ],
  "diseases": [
    { "name": "ชื่อโรคหรือแมลง", "type": "โรค หรือ แมลง หรือ ความเครียด", "likelihood": "สูง|ปานกลาง|ต่ำ", "evidence": "อาการที่เห็น", "management": "วิธีจัดการที่ทำได้จริง" }
  ],
  "fertilizer_plan": [
    { "nutrient": "Mg", "product": "กีเซอร์ไรท์ (MgSO4)", "rate": "0.3 กก./ต้น/ปี", "timing": "ต้นฤดูฝน", "method": "หว่านในแถวยางห่างโคนต้น 1 ม." }
  ],
  "smart_green_products": [
    { "name": "ชื่อผลิตภัณฑ์จากรายการที่อนุญาตเท่านั้น", "reason": "ช่วยแก้ปัญหาที่พบอย่างไร 1 ประโยค", "usage": "วิธีใช้/อัตรา (ถ้าไม่มีข้อมูลให้เขียน 'ใช้ตามอัตราบนฉลาก')" }
  ],
  "urgent_actions": ["สิ่งที่ควรทำทันทีภายใน 1-2 สัปดาห์"],
  "recommended_next_step": "ขั้นตอนถัดไป เช่น เก็บใบมาตรฐานส่งวิเคราะห์ ตรวจซ้ำใน 3 เดือน",
  "confidence": "สูง|ปานกลาง|ต่ำ"
}
หมายเหตุ: "diseases" ให้ใส่เฉพาะที่มีหลักฐานจากภาพหรือข้อมูลแปลง หากไม่พบให้เป็น [] ; "health_score" 0-100 (100 = สมบูรณ์มาก)
`.trim();
}

function asString(v, fallback = '-') {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function pickEnum(value, allowed, fallback) {
  const s = asString(value, '');
  return allowed.find(a => s === a) || allowed.find(a => s.includes(a)) || fallback;
}

/** Normalize the AI reply into a predictable shape for the frontend. */
export function normalizeRubberResult(parsed, payload) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};

  const nutrientMap = new Map();
  for (const item of Array.isArray(p.nutrient_status) ? p.nutrient_status : []) {
    if (!item || typeof item !== 'object') continue;
    const code = asString(item.code || item.nutrient, '').replace(/[^A-Za-z]/g, '');
    const match = RUBBER_NUTRIENTS.find(n => n.code.toLowerCase() === code.toLowerCase());
    if (match) nutrientMap.set(match.code, item);
  }
  const nutrientStatus = RUBBER_NUTRIENTS.map(n => {
    const item = nutrientMap.get(n.code) || {};
    return {
      code: n.code,
      name: n.name,
      status: pickEnum(item.status, STATUS_LEVELS, 'ต้องตรวจเพิ่ม'),
      evidence: asString(item.evidence, 'ไม่พบข้อมูลจากภาพ'),
    };
  });

  const diseases = (Array.isArray(p.diseases) ? p.diseases : [])
    .filter(d => d && typeof d === 'object' && d.name)
    .map(d => ({
      name: asString(d.name),
      type: asString(d.type, 'โรค'),
      likelihood: pickEnum(d.likelihood, LIKELIHOODS, 'ต่ำ'),
      evidence: asString(d.evidence),
      management: asString(d.management),
    }));

  const fertilizerPlan = (Array.isArray(p.fertilizer_plan) ? p.fertilizer_plan : [])
    .filter(f => f && typeof f === 'object' && (f.product || f.nutrient))
    .map(f => ({
      nutrient: asString(f.nutrient, ''),
      product: asString(f.product),
      rate: asString(f.rate),
      timing: asString(f.timing),
      method: asString(f.method),
    }));

  const seenProducts = new Set();
  const smartGreenProducts = [];
  for (const item of Array.isArray(p.smart_green_products) ? p.smart_green_products : []) {
    if (!item || typeof item !== 'object') continue;
    const product = matchRubberProduct(normalizeSmartGreenProductText(asString(item.name, '')));
    if (!product || seenProducts.has(product.key)) continue; // drop anything not on the approved list
    seenProducts.add(product.key);
    smartGreenProducts.push({
      key: product.key,
      name: product.name,
      image: product.image,
      reason: normalizeSmartGreenProductText(asString(item.reason, product.description)),
      // Only show rates the technical team approved in rubberProducts.js — never AI-invented ones
      usage: product.usage || 'ใช้ตามอัตราบนฉลาก',
    });
  }

  let score = parseInt(p.health_score, 10);
  if (Number.isNaN(score)) score = 60;
  score = Math.max(0, Math.min(100, score));

  const urgent = Array.isArray(p.urgent_actions)
    ? p.urgent_actions.map(a => asString(a, '')).filter(Boolean)
    : (p.urgent_actions ? [asString(p.urgent_actions)] : []);

  return {
    success: true,
    crop: 'rubber',
    customerName: payload.customerName || '',
    inspectorName: payload.inspectorName || '',
    treeAge: payload.treeAge || '',
    tappingStatus: payload.tappingStatus || '',
    variety: payload.variety || '',
    province: payload.province || '',
    coordinates: payload.coordinates || '',
    soilType: payload.soilType || '',
    waterStatus: payload.waterStatus || '',
    soilPh: payload.soilPh || 'ไม่ได้วัด',
    yieldPerRai: payload.yieldPerRai || '',
    lastFertilizer: payload.lastFertilizer || '',
    observedSymptoms: Array.isArray(payload.observedSymptoms) ? payload.observedSymptoms : [],
    youngLeafAnalysis: asString(p.young_leaf_analysis),
    matureLeafAnalysis: asString(p.mature_leaf_analysis),
    oldLeafAnalysis: asString(p.old_leaf_analysis),
    treeAnalysis: asString(p.tree_analysis, 'ไม่มีภาพ'),
    healthScore: score,
    primaryIssue: asString(p.primary_issue, 'ต้องตรวจเพิ่ม'),
    overallSummary: asString(p.overall_summary),
    nutrientStatus,
    diseases,
    fertilizerPlan,
    smartGreenProducts,
    urgentActions: urgent,
    recommendedNextStep: asString(p.recommended_next_step),
    confidence: pickEnum(p.confidence, LIKELIHOODS, 'ปานกลาง'),
  };
}

/** Returns an error message (Thai) when the payload is invalid, otherwise null. */
export function validateRubberPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.images) {
    return 'ไม่พบข้อมูลรูปภาพ';
  }
  const missing = RUBBER_IMAGE_SLOTS
    .filter(s => s.required && !(payload.images[s.key] && payload.images[s.key].base64))
    .map(s => s.label);
  if (missing.length) {
    return `กรุณาอัปโหลดรูปให้ครบ: ${missing.join(', ')}`;
  }
  return null;
}

/** Labels of submitted image slots the model marked as not-rubber in image_checks. */
export function failedImageChecks(parsed, payload) {
  const checks = parsed && Array.isArray(parsed.image_checks) ? parsed.image_checks : [];
  return RUBBER_IMAGE_SLOTS
    .filter((slot) => payload.images && payload.images[slot.key])
    .filter((slot) => checks.some((c) => c && c.slot === slot.key && (c.is_rubber === false || c.is_rubber === 'false')))
    .map((slot) => slot.label);
}

const PRECHECK_PROMPT = `
ตรวจภาพแต่ละภาพด้านบนอย่างเข้มงวด โดยดูจากภาพเท่านั้น (ไม่มีข้อมูลอื่นประกอบ)
ภาพผ่านได้เมื่อเป็น "ภาพถ่ายจริง" ที่เห็นส่วนของต้นยางพาราชัดเจน: ใบ ฉัตรใบ กิ่ง ลำต้น หน้ากรีด หรือโคนต้น
(ใบยางพาราเป็นใบประกอบ 3 ใบย่อย ใบรี ผิวมัน; ภาพสวนจริงที่มีพื้นหลังรกหรือเห็นต้นยางเพียงบางส่วนถือว่าผ่าน)
ภาพไม่ผ่าน: ภาพวาด ภาพกราฟิก ลวดลาย/รูปทรงเรขาคณิต ภาพสีพื้น ภาพหน้าจอ เอกสาร คน สัตว์ สิ่งของ
พืชชนิดอื่น (ปาล์ม อ้อย มันสำปะหลัง ข้าวโพด ฯลฯ) หรือภาพมืด/เบลอจนมองไม่เห็นใบหรือลำต้น
ตอบ JSON เท่านั้น: {"image_checks":[{"slot":"young","is_rubber":true,"seen":"สิ่งที่เห็นจริงในภาพ 1 ประโยค"}]}
`.trim();

function imageParts(payload) {
  const parts = [];
  for (const slot of RUBBER_IMAGE_SLOTS) {
    const img = payload.images[slot.key];
    if (img && img.base64) {
      parts.push({ text: `ภาพ slot="${slot.key}": ${slot.label}` });
      parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } });
    }
  }
  return parts;
}

/**
 * Step 1: judge the photos alone, without the farmer's text. With symptoms in the prompt the
 * model tends to "see" them in any image, so this check must not see the context.
 * Returns labels of failed slots; fails open (returns []) if the check itself errors or times out.
 */
export async function precheckImages(payload, traceId) {
  try {
    const parsed = await generateJsonWithFallback([...imageParts(payload), { text: PRECHECK_PROMPT }],
      `${traceId}-precheck`, { timeoutMs: 12000, totalBudgetMs: 18000 });
    const failed = failedImageChecks(parsed, payload);
    if (failed.length) console.warn(`[${traceId}] precheck rejected:`, JSON.stringify(parsed.image_checks));
    return failed;
  } catch (err) {
    console.warn(`[${traceId}] precheck skipped:`, err.message);
    return [];
  }
}

export async function analyzeRubber(payload, traceId) {
  const rejected = await precheckImages(payload, traceId);
  if (rejected.length) {
    const err = new Error(`ภาพตำแหน่ง ${rejected.join(', ')} ไม่ใช่ภาพถ่ายยางพาราที่วิเคราะห์ได้ กรุณาถ่ายภาพใบยางพาราจริงใหม่อีกครั้ง`);
    err.isInvalidImage = true;
    throw err;
  }

  // Images go first (each labelled with its slot key) so the model looks at the photos
  // before it reads the farmer's context, which otherwise invites made-up findings.
  const contents = [...imageParts(payload), { text: buildRubberPrompt(payload) }];

  const parsed = await generateJsonWithFallback(contents, traceId, { timeoutMs: 22000, totalBudgetMs: 38000 });

  const failed = failedImageChecks(parsed, payload);
  if (parsed && (parsed.is_rubber === false || failed.length)) {
    const err = new Error(
      parsed.invalid_image_reason ||
      (failed.length ? `ภาพตำแหน่ง ${failed.join(', ')} ไม่ใช่ภาพยางพาราที่วิเคราะห์ได้ กรุณาถ่ายภาพใหม่อีกครั้ง` : '') ||
      'ระบบตรวจพบว่าภาพที่อัปโหลดไม่ใช่ยางพารา กรุณาถ่ายภาพใบยางพาราใหม่อีกครั้ง'
    );
    err.isInvalidImage = true;
    throw err;
  }

  return normalizeRubberResult(parsed, payload);
}

/**
 * Framework-agnostic request handler: takes a parsed payload, returns { status, body }.
 * Used by the Vercel function api/analyze.js (also run by the local server.js).
 */
export async function handleRubberRequest(payload) {
  const traceId = `RUBBER-${Date.now()}`;
  const invalid = validateRubberPayload(payload);
  if (invalid) return { status: 400, body: { error: invalid } };

  try {
    const result = await analyzeRubber(payload, traceId);
    result.traceId = traceId;
    console.log(`[${traceId}] SUCCESS | ${result.primaryIssue} | score ${result.healthScore}`);
    return { status: 200, body: result };
  } catch (err) {
    if (err.isInvalidImage) {
      console.warn(`[${traceId}] REJECTED image:`, err.message);
      return { status: 400, body: { success: false, isInvalidImage: true, error: err.message } };
    }
    console.error(`[${traceId}] FAILED:`, err);
    const msg = String(err?.message || err);
    if (isBusyError(err) || /หมดเวลา/.test(msg)) {
      return { status: 503, body: { error: BUSY_MESSAGE_TH } };
    }
    return { status: 500, body: { error: `เกิดข้อผิดพลาดในการวิเคราะห์: ${err?.message || err}` } };
  }
}
