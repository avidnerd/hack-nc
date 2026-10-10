# Is Scrub+ clinically useful? Workflow and evidence review

A literature review done on 2026-10-10 to check Scrub+ against how liver resection and
EVAR are really planned, and against the evidence on touchless interfaces in the OR.
Sources are at the end. Where we could only read an abstract or a secondary summary, or
could not confirm a figure, the text says so.

**Verdict.** Scrub+ fits real, evidence-backed uses:
- reviewing a preoperative plan at the table without breaking scrub;
- explaining surgery to patients;
- teaching and multidisciplinary discussion.

It is not a planning tool for real operations, and the literature gives no basis for
claiming it saves time or improves outcomes. That holds even for mature touchless systems.

---

## 1. How liver resection is planned today

1. **Imaging.** Multiphase contrast CT (arterial, portal-venous, often delayed). For
   colorectal liver metastases, gadoxetic-acid MRI is often added. In one series it changed
   management in 18 % of patients thought resectable on CT [L1].
2. **Segmentation and volumetry.** A radiologist or 3D lab does this, either in-house
   (Fujifilm Synapse 3D / Vincent, Siemens syngo.via, OsiriX) or through an outsourced
   service (MeVis Distant Services, Visible Patient). Synapse segments the liver, tumours
   and vessels and *approximates vascular territories*. It is FDA-cleared to aid treatment
   planning by trained imaging professionals [L3, L4].
3. **Multidisciplinary tumour board.** It decides resectability, which depends on more than
   lesion count:
   - whether R0 (clear margins) is achievable;
   - whether the remnant has enough volume and function;
   - the quality of the background liver.
4. **Operative decisions.**
   - **Anatomical (Couinaud) vs parenchyma-sparing resection.** For colorectal metastases,
     survival is similar, and anatomical resection costs more time and blood. For
     hepatocellular carcinoma (HCC), anatomical resection is generally preferred [L6].
   - **Portal vein embolization**, if the future remnant is too small [L7].

### Numbers surgeons actually use

| Quantity | Typical threshold | Note |
|---|---|---|
| Future liver remnant (FLR) | ≥20 % normal liver, ≥30 % after chemotherapy or with steatosis, ≥40 % cirrhosis | Practice varies widely; some centres use 30/40/50 % [L8] |
| Standardized FLR | FLR ÷ estimated total liver volume, TLV = −794.41 + 1267.28 × BSA (Vauthey) | Corrects for patient size [L9] |
| FLR ÷ body weight | > 0.5 % | ≤0.5 % raised morbidity and mortality after extended right hepatectomy [L10] |
| Margin | R0 (any clear margin) is the goal; ≥1 cm is associated with better survival than <1 cm | Some of the margin effect reflects tumour biology. Treat 1 mm as a floor and 10 mm as a target [L13] |
| Venous outflow | Right / middle / left hepatic veins drain about 40 / 33 / 21 % of the liver | Dividing a vein congests its territory, so the remnant functions less than its volume suggests [L14] |

### Does 3D planning help?

- **Meta-analyses:** 3D-guided resection is associated with:
  - shorter operations (about −40 min laparoscopically);
  - less blood loss (about −50 mL);
  - fewer complications in some analyses.

  The studies are almost all observational, small and single-centre. There are no RCTs
  [L15, L16].
- **Volume prediction:** predicted and actual resected volume correlate well (r = 0.80–0.99),
  but are biased in both directions by 10–20 % [L17].
- **What surgeons value most:** vessel–tumour relationships and vascular territory mapping
  [L3, L5, L14]. We found no formal survey ranking features.

### In the operating room

- **Current practice:** surgeons consult images on a wall monitor and tell a non-sterile
  nurse what to show, use draped controls, or break scrub [T2, T3].
- **Intraoperative ultrasound** is the standard for finding tumours and vessels. **ICG
  fluorescence** helps define margins: in one robotic series it mandated a wider resection
  in 7.9 % of cases. It only penetrates about 10 mm [L24, L25].
- **Frequency:** we found **no study measuring how often surgeons look at imaging or break
  scrub.** The often-quoted "10 minutes to re-scrub" is from a news piece and a vendor blog,
  not a peer-reviewed measurement.

## 2. How EVAR is planned today

- **Imaging.** Arterial-phase CTA with slices of 1 mm or thinner. The rule: plan on a
  centerline reconstruction, never on axial slices [E8, E9].
- **Measurements, taken perpendicular to the centerline:**
  - proximal neck diameter, at the lowest renal artery and 10–15 mm below it;
  - neck length, from the lowest renal artery to where the diameter first grows by >10 %;
  - suprarenal (α) and infrarenal (β) angulation;
  - neck shape, thrombus and calcium;
  - lengths to the bifurcation and to the internal iliacs;
  - iliac landing zones of 10–15 mm;
  - access vessel diameters [E3, E4, E12].

  Planning takes about 10 minutes per case in 3mensio, OsiriX or syngo.via. Observers agree
  only moderately to well [E10].
- **Where a graft seals.** A standard graft seals in the **infrarenal neck, below the lowest
  renal artery**. Only an uncovered suprarenal bare stent may cross the renals, on some
  devices. Short necks call for fenestrated or branched grafts [E4, E5].
- **Device rules (from instructions for use):**
  - neck ≥10–15 mm;
  - 10–20 % oversize (above 30 % may be harmful);
  - infrarenal angulation ≤60° on most devices.

  A hostile neck is roughly any of: length <10–15 mm, angulation >60°, diameter >28–32 mm,
  conical shape, or circumferential thrombus or calcium [E5, E6, E12]. Type I endoleak rose
  from 9 % (angulation <45°) to 38 % (≥60°) [E12].
- **Oversizing does not widen the aorta on purpose.** Over time, neck dilatation affects
  about 25 % of patients, and aggressive oversizing is associated with it [E3, E6].
- **Flow.** Aortic flow is pulsatile (Womersley number about 7–19), so a Poiseuille model is
  qualitative at best. Computational fluid dynamics (CFD) in EVAR is still a research tool:
  28 studies, none prospectively validated [E11, E14].
- **"A stent opens a narrowing"** describes aortoiliac occlusive disease (for example CERAB),
  not aneurysm repair [E13].

## 3. Touchless interaction in the OR

- **Reviews:**
  - In one review of 55 papers, 62 % of systems control image viewers, but only 8 were
    tested in a real clinical environment [T8].
  - Another review covered 86 studies; most were proof-of-concept, with only 2 RCTs.
    Learning takes 4.5–30 min. Problems were lighting, occlusion, bystanders and fatigue
    [T10].
- **Speed:** a mouse is fastest, gesture control next, and telling an assistant slowest
  (109 / 215 / 246 s; randomized crossover, n = 30) [T12]. Leap Motion beat Kinect for
  precise tasks [T13].
- **Voice:** OR systems differ a lot (2.4 vs 14.7 repeated commands across two commercial
  systems) [T15]. Simulated OR noise gives 13–19 % word error rate [T18]. A deployed study
  found surgeons needed both voice and gesture, so redundancy matters [T14, T11].
- **Design lessons the literature supports:**
  - explicit engage/disengage (a neutral zone, a sleep pose, a wake word);
  - a small gesture vocabulary;
  - clear visual feedback, because there is no haptic feedback;
  - low latency and filtered jitter;
  - a fallback input;
  - short arm-raised time to avoid "gorilla arm" fatigue, for which no OR measurements exist
    [T5, T11, T19].
- **Adoption:** GestSure (Kinect) reached a few hospitals and showed feasibility in
  neuroendovascular cases [T20]. Adoption stayed limited: few trials, and hospital purchasing
  does not follow surgeon demand.

## 4. Patient communication

RCTs show better *objective* comprehension with 3D models:
- an intracranial-tumour VR consent trial [T21];
- a Mohs surgery trial;
- a liver-model pilot (understood the extent of disease: 100 % vs 70 %) [L18].

Effects on anxiety are mixed. Scrub+'s patient mode is the best-supported part of the
product.

## 5. Regulatory framing

Software that processes medical images stays a medical device even when it meets the other
US clinical-decision-support exemption criteria. 3D surgical-planning viewers are normally
Class II (21 CFR 892.2050) [T22]. Scrub+ must therefore be presented as **a research and
educational demonstration, not a medical device and not for clinical use**. It must avoid
words like "diagnose", "recommend", "safe to resect" or "sizes the stent for the patient".

---

## 6. What we changed after this review

| Finding | Change |
|---|---|
| Infrarenal grafts seal **below** the renals; ours sat above them and "sealed" | The covered graft must start at or below the lowest renal; it seats 2 mm below it, and the demo's failure case is dragging it *up* |
| Renal ostium estimate was 20–25 mm too low | Estimated at kidney-hilum level (`pipeline/ostia.py`) |
| The old aorta case (liver_0) had 5 mm slices and only ~30 mm of infrarenal aorta; planning CTA uses ≤1 mm | Replaced by liver_8 (1 mm slices, ~130 mm infrarenal, picked from three thin-slice candidates by a TotalSegmentator screen); the device is an 80 mm main body. The liver case now ships at its native 1.0 mm instead of 1.77 mm |
| Oversizing does not widen the aorta | The flow model caps the stented lumen at the healthy reference radius; flow resistance stays at about 100 on this healthy aorta, instead of a fake drop to 42 |
| Flow is qualitative | The card reads "illustrative 1D model, not CFD" |
| A margin number is only meaningful with a location | The cut face draws the closest-approach segment, coloured against the threshold, and its length is tested to equal MARGIN |
| Surgeons care about specific vessel–tumour relationships | Each divided vessel is marked by name where the cut divides it, instead of the whole intrahepatic tree glowing |
| Predicted volumes are off by 10–20 %; remnant is volume, not function | Stated in the plan note's limitations |
| Unverified citations ("Lin et al. 2026") and implied time savings | Removed from the README; OR cost is now context only |

## 7. What would make it clinically meaningful next

These are in [docs/EXTRAS.md](EXTRAS.md):
1. a remnant adjusted for venous outflow (needs separate hepatic and portal veins);
2. Couinaud segment labels;
3. standardized FLR and FLR ÷ body weight with liver-quality presets;
4. a 1 mm R0 floor separate from the 10 mm target;
5. curved resection surfaces;
6. a real aneurysm case on thin-slice CTA;
7. an aortoiliac occlusive case for the flow story;
8. real-hand gesture data and a usability test with gloves, theatre lighting and OR noise.

---

## 8. Measurements ("Scrub, measure the …")

Researched before building. Each command reports the measurement the literature says is
reported for that structure, next to a published reference range.

| Structure | What we report | Reference shown | Source |
|---|---|---|---|
| Tumour | RECIST 1.1 longest axial diameter, perpendicular short axis, volume; largest connected lesion, edge to edge (+1 voxel) | Measurable at ≥10 mm; R0 margin goal | RECIST 1.1 [M1] |
| Liver | Total and healthy (minus tumour) volume, craniocaudal extent | Enlarged above ~16 cm (midclavicular span, which reads shorter); remnant 20 / 30 / 40 % | Radiopaedia [M2], Vauthey [L9] |
| Aorta | Largest inscribed diameter, whole segment and infrarenal | Normal ~15–20 mm; aneurysm ≥30 mm; repair 55 mm men / 50 mm women | ESVS 2024 [E2], Radiopaedia [M3] |
| Kidney | Pole-to-pole length along the principal axis, volume | 100–130 mm | Radiopaedia [M4]; CT n = 1,040 [M5] |
| Portal vein | Trunk diameter within 20 mm of the liver | >13 mm suggests portal hypertension (ultrasound rule); CT normal ~15.5 ± 1.9 mm | [M6] |
| IVC | AP and transverse diameter at the renal level | 16.3 ± 2.9 and 25.8 ± 3.5 mm (CT, n = 200) | [M7] |

**Validated.** The tumour diameter matches an independent numpy brute force (66.9 vs
66.6 mm). liver_36's lesion is 39 mL, which is a 42 mm *equivalent sphere*. Earlier
docs called it a "42 mm lesion"; its RECIST diameter is 67 mm, because it is long and
flat (30 mm top to bottom). Its tumour label also carries a 0.01 mL speck elsewhere.
Measuring the largest component keeps that out.

**Limits shown on screen:**
- The aorta and veins are measured as lumen-like inscribed diameters. Planners use the
  outer wall, which reads 3–6 mm larger.
- The lumen neck here (~19 mm) sits near the 17 mm lower limit of most devices'
  instructions for use; necks under 18 mm get a flagged row.
- IVC collapsibility needs ultrasound over breathing, so we do not offer it.
- Kidneys cut off by the scan edge are flagged instead of measured short.

## 9. Suggestions and outcomes

**Suggestions** are rules over the surgeon's own thresholds:
- the margin is under target → "optimize";
- a ≥5 mm vessel is divided → re-angle the cut, or plan vessel control;
- the remnant is under the minimum → when teams consider portal vein embolization;
- a renal artery is covered → a distal seat, or fenestrated EVAR or chimney grafts.

**Outcomes** show *published cohort rates for the band the plan falls in, beside the other
band, with the study*. Only figures we verified against an abstract or the full text are
used:

| Plan quantity | Band | Published rates | Source |
|---|---|---|---|
| Remnant | <26.6 % vs ≥26.6 % | Severe liver dysfunction 45.5 % (10/22) vs 1.2 % (1/82) | Schindl et al., Gut 2005 [O1] |
| Standardized remnant | ≤20 % vs >20 % | Hepatic insufficiency 27.3 % (3/11) vs 5.2 % (5/96) | Shindoh et al., JACS 2013 [O2] |
| Margin | positive vs negative | Cut-surface recurrence 11 % vs ≤5 %; 5-year OS 17 % vs 62–71 %. Negative margins of 1–9 mm vs ≥10 mm did not differ | Pawlik et al., Ann Surg 2005 [O3] |
| Margin | ≥10 mm vs <10 mm | 5-year OS RR 0.91 (0.85–0.97) | Margonis et al., Ann Surg 2018 [L13] |
| EVAR neck | hostile vs not | 30-day type I endoleak OR 2.92; 30-day mortality 3.5 vs 2.4 %; migration 1.6 vs 0.9 % | Stather et al., J Endovasc Ther 2013 [O4] |
| Neck angulation | ≥60° vs <60° | Type Ia endoleak at 30 days 4.0 vs 1.8 %; at 3 years 5.6 vs 2.6 % | Bernardini et al., PLoS One 2022 [O5] |

**What we deliberately do not claim:**
- a personal probability ("your risk is 12 %");
- interpolation between bands;
- combined odds ratios;
- survival or recurrence from margin millimetres, since the grid error is about the size
  of the 1 mm cutpoint;
- rates by oversizing band, because none are pooled;
- "major hepatectomy" or segment counts from a planar cut;
- expected hypertrophy after portal vein embolization;
- dialysis rates after renal coverage.

Validated risk tools (MELD, ALBI, ICG-R15, ACS NSQIP) need lab values a CT does not
carry, and the card says so. Figures left out until checked against full text: Kishi
2009 per-group rates, AbuRahma 2011 neck-length rates, ISGLS grade mortality, Sadot 2015
medians.

## References

Liver planning
- [L1] MRI vs CT for CRLM treatment planning: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6238306/
- [L3] Fujifilm Synapse 3D Liver Analysis, FDA K110186: https://fda.innolitics.com/device/K110186
- [L4] MeVis Distant Services: https://www.mevis.de/en/solutions/professional/mevis-distant-services-mds
- [L5] Volumetry across software packages: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9674751/
- [L6] Anatomical vs non-anatomical resection meta-analyses: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10408219/ ; https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5006087/
- [L7] Portal vein embolization: https://www.thieme-connect.de/products/ejournals/html/10.1055/s-0039-1689042
- [L8] FLR thresholds and practice variation: https://pmc.ncbi.nlm.nih.gov/articles/PMC8132340
- [L9] Vauthey, BSA predicts total liver volume: https://mdanderson.elsevierpure.com/en/publications/body-surface-area-and-body-weight-predict-total-liver-volume-in-w
- [L10] Truant 2007, remnant-to-body-weight ratio: https://pubmed.ncbi.nlm.nih.gov/17189109
- [L13] Margonis et al. 2018, margin width meta-analysis (pooled figures from a secondary summary): https://pergamos.lib.uoa.gr/uoa/dl/object/3123321
- [L14] Hepatic venous drainage territories and congestion: https://pmc.ncbi.nlm.nih.gov/articles/PMC5144551
- [L15] 3D-guided hepatectomy meta-analysis: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9489363/
- [L16] 3D reconstruction in laparoscopic hepatectomy meta-analysis: https://pmc.ncbi.nlm.nih.gov/articles/PMC9274042
- [L17] Predicted vs actual resected volume: https://link.springer.com/doi/10.1007/s00464-014-3611-x
- [L18] 3D liver models for patient education, randomized pilot: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9970129/
- [L24] Intraoperative ultrasound and ICG limits: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10302397/
- [L25] ICG in robotic liver resection: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10390613/

EVAR
- [E3] Oversizing and neck dilatation: https://www.mdpi.com/2077-0383/11/5/1203
- [E4] Hu, Pisimisis, Sheth 2018, EVAR planning review: https://cdt.amegroups.org/article/view/18349/html
- [E5] Pitros et al. 2022, device IFUs and hostile necks: https://pmc.ncbi.nlm.nih.gov/articles/PMC9428821/
- [E6] van Prehn 2009, oversizing review: https://repub.eur.nl/pub/27000
- [E8] Technical aspects of EVAR: https://heibib.ub.uni-heidelberg.de/search/Record/1583824928
- [E9] UK Vascular Society, EVAR planning: https://vascularsociety.org.uk/_userfiles/pages/files/evar-planning-_003_.pdf
- [E10] Planning time and interobserver agreement: https://scholarlypublications.universiteitleiden.nl/access/item%3A3308515/download
- [E11] Numerical methods in EVAR, scoping review: https://pmc.ncbi.nlm.nih.gov/articles/PMC11682169
- [E12] Neck angulation and endoleak: https://link.springer.com/article/10.1007/s00270-015-1260-7
- [E13] CERAB outcomes: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11476575/
- [E14] Pulsatile aortic flow: https://arxiv.org/pdf/1802.03722
- ESVS 2024 AAA guidelines (Wanhainen et al., EJVES 67:192–331), which we could not retrieve in full: https://doi.org/10.1016/j.ejvs.2023.11.002

Touchless interaction, patient education, regulation
- [T2] Johnson et al. 2011, CHI, touchless interaction in interventional radiology: https://oro.open.ac.uk/28000
- [T3] O'Hara et al. 2014, CACM, which we could not read in full: https://eprints.lancs.ac.uk/id/eprint/72511/
- [T5] Wachs et al. 2008, Gestix, JAMIA: https://cris.bgu.ac.il/en/publications/a-gesture-based-tool-for-sterile-browsing-of-radiology-images-2/
- [T6] Strickland et al. 2013, Can J Surg: https://doi.org/10.1503/cjs.035311
- [T8] Mewes et al. 2017, IJCARS: https://link.springer.com/doi/10.1007/s11548-016-1480-6
- [T10] Alvarez-Lopez et al. 2019, JMIR: https://pmc.ncbi.nlm.nih.gov/articles/PMC6533048
- [T11] Schreiter et al. 2024, multimodal OR interaction review: https://pmc.ncbi.nlm.nih.gov/articles/PMC12034581/
- [T12] Wipfli et al. 2016, PLOS ONE: https://pmc.ncbi.nlm.nih.gov/articles/PMC4833285/
- [T13] Feng et al. 2021, Kinect vs Leap Motion: https://www.ovid.com/journals/suinn/pdf/10.1177/1553350620947206~comparison-of-kinect-and-leap-motion-for-intraoperative
- [T14] Mentis et al. 2015, voice or gesture in the OR: https://www.microsoft.com/en-us/research/?p=646083
- [T15] Perrakis et al. 2013, OR voice systems: https://www.springermedizin.de/integrated-operation-systems-and-voice-recognition-in-minimally-/8538054
- [T18] Speech recognition under OR noise: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12832711/
- [T19] Hincapié-Ramos et al. 2014, Consumed Endurance: https://hci.cs.umanitoba.ca/publications/details/consumed-endurance-a-metric-to-quantify-arm-fatigue-of-mid-air-interactions
- [T20] Dmytriw et al. 2019, GestSure: https://link.springer.com/10.1007/s00062-019-00829-6
- [T21] Perin et al. 2021, Acta Neurochir: https://doi.org/10.1007/s00701-020-04303-y
- [T22] FDA clinical decision support guidance: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software ; example 892.2050 clearance: https://www.accessdata.fda.gov/cdrh_docs/pdf22/K223639.pdf
- Childers & Maggard-Gibbons 2018, JAMA Surg, OR cost: https://pubmed.ncbi.nlm.nih.gov/29490366/

Measurements and outcomes
- [M1] RECIST 1.1: https://recist.eortc.org/?p=176 ; https://radiologyassistant.nl/more/recist-1-1/recist-1-1-1
- [M2] Hepatomegaly: https://radiopaedia.org/articles/hepatomegaly
- [M3] Abdominal aortic aneurysm: https://radiopaedia.org/articles/abdominal-aortic-aneurysm
- [M4] Normal kidney size: https://radiopaedia.org/articles/normal-kidneys-size-in-adults
- [M5] Kidney length on CT, n = 1,040: https://pmc.ncbi.nlm.nih.gov/articles/PMC2813848
- [M6] Portal vein diameter on CT: https://researchers.mq.edu.au/en/publications/normal-main-portal-vein-diameter-measured-on-ct-is-larger-than-th/
- [M7] IVC diameter on CT: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9789330/
- [E2] ESVS 2024 summary: https://evtoday.com/articles/2024-mar/highlights-from-the-esvs-2024-clinical-practice-guidelines-on-the-management-of-abdominal-aortoiliac-artery-aneurysms
- [O1] Schindl et al., Gut 2005: https://pmc.ncbi.nlm.nih.gov/articles/PMC1774834/
- [O2] Shindoh et al., J Am Coll Surg 2013: https://pmc.ncbi.nlm.nih.gov/articles/PMC3632508/
- [O3] Pawlik et al., Ann Surg 2005: https://pmc.ncbi.nlm.nih.gov/articles/PMC1357126/
- [O4] Stather et al., J Endovasc Ther 2013 (PMID 24093314): https://pubmed.ncbi.nlm.nih.gov/24093314/
- [O5] Bernardini et al., PLoS One 2022: https://pmc.ncbi.nlm.nih.gov/articles/PMC8870420/
- Risk communication (Trevena et al. 2013): https://orca.cardiff.ac.uk/id/eprint/110573
