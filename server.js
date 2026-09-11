require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

const FLOWQ_API_URL = process.env.FLOWQ_API_URL || 'https://api.infinityflow3d.com';
const FLOWQ_API_KEY = process.env.FLOWQ_API_KEY;

// 1. Preis-Algorithmus: 0,50 € pro 0,50 g (1,00 € pro Gramm)
function calculatePrice(weightInGrams) {
    const pricePerHalfGram = 0.50;
    const price = (weightInGrams / 0.50) * pricePerHalfGram;
    return Math.max(price, 1.50); // Minimum 1,50 € Startpreis
}

// 2. Extrahieren des Gewichts aus Bambu .3mf oder .gcode
async function extractFilamentWeight(filePath, originalName) {
    try {
        if (originalName.endsWith('.3mf')) {
            const data = fs.readFileSync(filePath);
            const zip = await JSZip.loadAsync(data);
            
            // Bambu Studio speichert Slice-Infos in Metadata/slice_info.config
            const sliceInfoFile = zip.file("Metadata/slice_info.config");
            if (sliceInfoFile) {
                const content = await sliceInfoFile.async("string");
                const match = content.match(/used_g\s*=\s*"?([\d\.]+)"?/i) || content.match(/weight_g\s*=\s*"?([\d\.]+)"?/i);
                if (match && match[1]) return parseFloat(match[1]);
            }

            // Fallback: Suche in eingebetteten G-Code Dateien im 3MF
            for (const filename of Object.keys(zip.files)) {
                if (filename.endsWith('.gcode')) {
                    const gcodeText = await zip.files[filename].async("string");
                    const match = gcodeText.match(/filament used \[g\]\s*=\s*([\d\.]+)/i);
                    if (match && match[1]) return parseFloat(match[1]);
                }
            }
        } else {
            // Standard .gcode Analyse
            const content = fs.readFileSync(filePath, 'utf8');
            const match = content.match(/filament used \[g\]\s*=\s*([\d\.]+)/i);
            if (match && match[1]) return parseFloat(match[1]);
        }
    } catch (err) {
        console.error("Fehler bei Gewichts-Analyse:", err.message);
    }
    return 15.0; // Fallback Wert in Gramm
}

// Endpoint: Datei Analyse & Preisberechnung
app.post('/api/quote', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Keine Datei empfangen.' });

    const weightGrams = await extractFilamentWeight(req.file.path, req.file.originalname);
    const price = calculatePrice(weightGrams);

    res.json({
        fileId: req.file.filename,
        originalName: req.file.originalname,
        weightGrams: weightGrams.toFixed(2),
        priceEuro: price.toFixed(2)
    });
});

// Endpoint: Automatischen Druck via FlowQ API auslösen
app.post('/api/order', async (req, res) => {
    const { fileId, customerName, printerGroupId } = req.body;
    if (!fileId) return res.status(400).json({ error: 'Ungültige Datei-ID.' });

    const filePath = path.join(__dirname, 'uploads', fileId);

    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));
        if (printerGroupId) formData.append('group_id', printerGroupId);
        formData.append('auto_start', 'true');

        // FlowQ API Aufruf mit Bearer Token
        const response = await axios.post(`${FLOWQ_API_URL}/v1/jobs`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${FLOWQ_API_KEY}`
            }
        });

        // Temporäre Datei nach Upload aufräumen
        fs.unlink(filePath, () => {});

        res.json({
            success: true,
            message: 'Druckauftrag erfolgreich an FlowQ gesendet!',
            jobId: response.data.id || response.data.job_id
        });
    } catch (error) {
        console.error('FlowQ API Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Fehler beim Starten des Druckauftrags über FlowQ.',
            details: error.response?.data || error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`3D Print Shop Server läuft auf Port ${PORT}`));
