const fs = require('fs');
const path = require('path');

const TASKS_FILE = path.join(__dirname, 'tasks.json');

function getTasks() {
    try {
        if (fs.existsSync(TASKS_FILE)) {
            let tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
            const now = new Date();
            
            // Auto hapus jika sudah selesai DAN melewati deadline
            const filtered = tasks.filter(t => {
                if (t.selesai) {
                    const d = new Date(t.deadline);
                    if (d < now) return false; // Hapus
                }
                return true;
            });

            if (filtered.length !== tasks.length) {
                saveTasks(filtered);
                tasks = filtered;
            }

            return tasks.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
        }
    } catch (e) {}
    return [];
}

function saveTasks(tasks) {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

module.exports = { getTasks, saveTasks };