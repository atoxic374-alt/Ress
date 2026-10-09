const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const colorManager = require('./colorManager');

const vacationsPath = path.join(__dirname, '..', 'data', 'vacations.json');
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');

// نظام حماية الرولات مشابه لنظام الداون
class VacationRoleProtection {
    constructor() {
        // قائمة تتبع الاستعادات التي يقوم بها البوت (لمنع التداخل مع نظام الحماية)
        this.botRestorationTracking = new Set();
        // قائمة مؤقتة لتجاهل الاستعادة التلقائية عند الإنهاء اليدوي
        this.autoRestoreIgnoreList = new Map();
    }

    // إضافة مفتاح لقائمة التجاهل المؤقت
    addToAutoRestoreIgnore(userId, roleId) {
        const key = `${userId}_${roleId}`;
        this.autoRestoreIgnoreList.set(key, Date.now());

        // إزالة من القائمة بعد 60 ثانية
        setTimeout(() => {
            this.autoRestoreIgnoreList.delete(key);
        }, 60000);

        console.log(`🛡️ تم إضافة ${key} لقائمة تجاهل استعادة الرولات المؤقت`);
    }

    // التحقق من وجود رول في قائمة التجاهل
    isInAutoRestoreIgnore(userId, roleId) {
        const key = `${userId}_${roleId}`;
        const timestamp = this.autoRestoreIgnoreList.get(key);

        if (!timestamp) return false;

        // إذا مر أكثر من 60 ثانية، احذف وارجع false
        if (Date.now() - timestamp > 60000) {
            this.autoRestoreIgnoreList.delete(key);
            return false;
        }

        return true;
    }

    // تسجيل عملية استعادة بواسطة البوت
    trackBotRestoration(guildId, userId, roleId) {
        const restorationKey = `${guildId}_${userId}_${roleId}`;
        this.botRestorationTracking.add(restorationKey);

        // إزالة المفتاح بعد 10 ثوانٍ
        setTimeout(() => {
            this.botRestorationTracking.delete(restorationKey);
        }, 10000);

        console.log(`🔧 تم تسجيل استعادة رول بواسطة البوت: ${restorationKey}`);
    }

    // التحقق من أن الاستعادة تتم بواسطة البوت
    isBotRestoration(guildId, userId, roleId) {
        const restorationKey = `${guildId}_${userId}_${roleId}`;
        return this.botRestorationTracking.has(restorationKey);
    }
}

const roleProtection = new VacationRoleProtection();

// --- Helper Functions ---
function readJson(filePath, defaultData = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
    }
    return defaultData;
}

function saveVacations(data) {
    const tempPath = `${vacationsPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        fs.renameSync(tempPath, vacationsPath);
        return true;
    } catch (error) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        console.error('Error writing vacations.json:', error);
        return false;
    }
}

function isUnknownMemberError(error) {
    const code = Number(error?.code ?? error?.rawError?.code);
    const status = Number(error?.status ?? error?.statusCode);
    return code === 10007 || status === 404;
}

function getRetryDelayMs(error, fallbackMs = 120000) {
    const retryAfter = Number(error?.retryAfter ?? error?.data?.retry_after ?? error?.rawError?.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.max(1000, retryAfter > 1000 ? retryAfter : retryAfter * 1000);
    }
    const match = String(error?.message || '').match(/retry after\s+([\d.]+)\s*(ms|seconds?|s)?/i);
    if (match) {
        const value = Number(match[1]);
        return Math.max(1000, Math.ceil(value * (/^ms$/i.test(match[2] || '') ? 1 : 1000)));
    }
    return fallbackMs;
}

// Discord's unfiltered GuildMemberManager.fetch() requests the whole guild over
// Gateway opcode 8. A single-member REST lookup avoids chunking/rate-limit spikes.
async function fetchGuildMemberById(guild, userId) {
    const cached = guild.members.cache.get(String(userId));
    if (cached) return cached;
    return guild.members.fetch({ user: String(userId), force: true });
}

let responsibilityMutationQueue = Promise.resolve();
function withResponsibilityMutationLock(operation) {
    const next = responsibilityMutationQueue.then(operation, operation);
    responsibilityMutationQueue = next.catch(() => {});
    return next;
}

async function getResponsibilitiesForVacation() {
    const database = require('./database');
    const manager = database.getDatabase();
    const responsibilities = await manager.getResponsibilities();
    if (responsibilities && Object.keys(responsibilities).length > 0) return responsibilities;
    if (global.responsibilities && Object.keys(global.responsibilities).length > 0) return global.responsibilities;
    return responsibilities || {};
}

function captureResponsibilityAssignments(responsibilities, userId) {
    const assignments = [];
    for (const [name, config] of Object.entries(responsibilities || {})) {
        const responsibles = Array.isArray(config?.responsibles) ? config.responsibles.map(String) : [];
        const index = responsibles.indexOf(String(userId));
        if (index !== -1) {
            const roles = Array.isArray(config.roles) ? config.roles : (config.roleId ? [config.roleId] : []);
            assignments.push({ name, index, roleIds: [...new Set(roles.map(String).filter(Boolean))] });
        }
    }
    return assignments;
}

function syncResponsibilitiesSnapshot(responsibilities) {
    try {
        fs.writeFileSync(responsibilitiesPath, JSON.stringify(responsibilities || {}, null, 2), 'utf8');
        global.responsibilities = responsibilities;
    } catch (error) {
        console.error('❌ تعذر مزامنة ملف المسؤوليات مع قاعدة البيانات:', error.message);
    }
}

async function removeUserFromResponsibilities(userId, assignments) {
    return withResponsibilityMutationLock(async () => {
        const database = require('./database');
        const manager = database.getDatabase();
        let responsibilities = await manager.getResponsibilities();
        if ((!responsibilities || Object.keys(responsibilities).length === 0) && global.responsibilities && Object.keys(global.responsibilities).length > 0) {
            responsibilities = global.responsibilities;
        }
        const targets = Array.isArray(assignments) ? assignments : captureResponsibilityAssignments(responsibilities, userId);
        const failed = [];

        for (const assignment of targets) {
            const config = responsibilities[assignment.name];
            if (!config || !Array.isArray(config.responsibles)) {
                failed.push(assignment);
                continue;
            }
            const current = config.responsibles.map(String);
            if (!current.includes(String(userId))) continue;
            const updated = { ...config, responsibles: current.filter(id => id !== String(userId)) };
            if (!await manager.updateResponsibility(assignment.name, updated)) failed.push(assignment);
            else responsibilities[assignment.name] = updated;
        }

        syncResponsibilitiesSnapshot(responsibilities);

        return { assignments: targets, failed };
    });
}

async function restoreUserResponsibilities(userId, assignments = []) {
    if (!Array.isArray(assignments) || assignments.length === 0) return { failed: [] };
    return withResponsibilityMutationLock(async () => {
        const database = require('./database');
        const manager = database.getDatabase();
        let responsibilities = await manager.getResponsibilities();
        if ((!responsibilities || Object.keys(responsibilities).length === 0) && global.responsibilities && Object.keys(global.responsibilities).length > 0) {
            responsibilities = global.responsibilities;
        }
        const failed = [];

        for (const assignment of assignments) {
            const config = responsibilities[assignment.name];
            if (!config || !Array.isArray(config.responsibles)) {
                failed.push(assignment);
                continue;
            }
            const current = config.responsibles.map(String);
            if (current.includes(String(userId))) continue;
            const insertAt = Math.min(Math.max(Number(assignment.index) || 0, 0), current.length);
            current.splice(insertAt, 0, String(userId));
            const updated = { ...config, responsibles: current };
            if (!await manager.updateResponsibility(assignment.name, updated)) failed.push(assignment);
            else responsibilities[assignment.name] = updated;
        }

        syncResponsibilitiesSnapshot(responsibilities);

        return { failed };
    });
}

// --- Public Functions ---

function getSettings() {
    const vacations = readJson(vacationsPath, { settings: {} });
    return vacations.settings || {};
}

function isUserOnVacation(userId) {
    const vacations = readJson(vacationsPath);
    return !!vacations.active?.[userId];
}

async function approveVacation(interaction, userId, approverId) {
    const vacations = readJson(vacationsPath);
    const request = vacations.pending?.[userId];

    if (!request) {
        return { success: false, message: 'No pending vacation request found for this user.' };
    }

    // التحقق من أن الطلب لم يتم معالجته مسبقاً
    if (request.processed) {
        return { success: false, message: 'This request has already been processed.' };
    }

    // وضع علامة المعالجة لمنع النقر المتكرر
    request.processed = true;
    if (!saveVacations(vacations)) {
        request.processed = false;
        return { success: false, message: 'تعذر حفظ قفل الطلب؛ لم يتم بدء الإجازة.' };
    }

    const guild = interaction.guild;
    if (!guild) {
        request.processed = false;
        saveVacations(vacations);
        return { success: false, message: 'Interaction did not originate from a guild.' };
    }

    let member;
    try {
        member = await fetchGuildMemberById(guild, userId);
    } catch (error) {
        request.processed = false;
        saveVacations(vacations);
        return {
            success: false,
            message: isUnknownMemberError(error)
                ? 'User not found in the guild.'
                : `تعذر التحقق من العضو مؤقتًا: ${error.message}`
        };
    }

    let responsibilityAssignments;
    try {
        const responsibilities = await getResponsibilitiesForVacation();
        responsibilityAssignments = captureResponsibilityAssignments(responsibilities, userId);
    } catch (error) {
        console.error(`❌ تعذر حفظ مسؤوليات المستخدم ${userId} قبل الإجازة:`, error);
        request.processed = false;
        saveVacations(vacations);
        return { success: false, message: 'تعذر تحميل المسؤوليات وحفظها قبل بدء الإجازة.' };
    }

    const adminRoles = readJson(adminRolesPath, []);
    console.log(`📋 Admin Roles from file: ${JSON.stringify(adminRoles)}`);

    const responsibilityRoleIds = [...new Set(responsibilityAssignments.flatMap(item => item.roleIds || []))];
    const rolesToRemove = member.roles.cache.filter(role => adminRoles.includes(role.id) || responsibilityRoleIds.includes(role.id));
    let actuallyRemovedRoleIds = [];

    try {
        if (rolesToRemove.size > 0) {
            console.log(`🔧 محاولة سحب ${rolesToRemove.size} دور إداري من المستخدم ${member.user.tag}`);
            console.log(`📋 الأدوار المراد سحبها: ${rolesToRemove.map(r => r.name).join(', ')}`);

            await member.roles.remove(rolesToRemove, 'سحب لرولات الإدارية بسبب الإجازة');
            actuallyRemovedRoleIds = rolesToRemove.map(role => role.id);
        } else {
            console.log(`⚠️ لا توجد أدوار إدارية لسحبها من المستخدم ${member.user.tag}`);
        }
    } catch (error) {
        console.error(`Failed to remove roles from ${member.user.tag}:`, error);
        // We continue even if roles removal fail, but we log it
    }

    // إنشاء بيانات الإجازة النشطة مع ضمان حفظ الرولات
    const activeVacation = { 
        ...request, 
        status: 'active', 
        approvedBy: approverId, 
        approvedAt: new Date().toISOString(), 
        removedRoles: actuallyRemovedRoleIds,  // معرفات الرولات المسحوبة
        guildId: guild.id,  // حفظ معرف السيرفر
        responsibilityAssignments,
        responsibilitiesRemoved: responsibilityAssignments.length === 0
    };

    // حفظ بيانات العضو
    if (member) {
        activeVacation.memberData = {
            id: member.id,
            tag: member.user.tag,
            displayName: member.displayName,
        };
    }

    // حفظ معلومات الرولات التي تم إزالتها (كنسخة احتياطية)
    activeVacation.rolesData = [];
    if (actuallyRemovedRoleIds.length > 0) {
        for (const roleId of actuallyRemovedRoleIds) {
            const role = guild.roles.cache.get(roleId);
            if (role) {
                activeVacation.rolesData.push({
                    id: role.id,
                    name: role.name
                });
            } else {
                activeVacation.rolesData.push({
                    id: roleId,
                    name: 'رول غير معروف'
                });
            }
        }
    }

    if (!vacations.active) {
        vacations.active = {};
    }

    vacations.active[userId] = activeVacation;
    delete vacations.pending[userId];

    console.log(`💾 حفظ بيانات الإجازة للمستخدم ${userId}:`);
    console.log(`📋 removedRoles: ${activeVacation.removedRoles.join(', ')}`);
    console.log(`📋 rolesData: ${activeVacation.rolesData.map(r => `${r.name} (${r.id})`).join(', ')}`);
    console.log(`📅 تاريخ البدء: ${activeVacation.startDate}`);
    console.log(`📅 تاريخ الانتهاء: ${activeVacation.endDate}`);

    const saveResult = saveVacations(vacations);
    if (!saveResult) {
        console.error('❌ فشل في حفظ بيانات الإجازة!');
        request.processed = false;
        delete vacations.active[userId];
        vacations.pending[userId] = request;
        saveVacations(vacations);
        if (actuallyRemovedRoleIds.length > 0) {
            await member.roles.add(actuallyRemovedRoleIds, 'إلغاء اعتماد الإجازة بسبب فشل الحفظ').catch(rollbackError => {
                console.error(`❌ فشل إعادة رولات المستخدم ${userId} بعد تعذر حفظ الإجازة:`, rollbackError.message);
            });
        }
        return { success: false, message: 'فشل في حفظ بيانات الإجازة' };
    }

    if (responsibilityAssignments.length > 0) {
        try {
            const removal = await removeUserFromResponsibilities(userId, responsibilityAssignments);
            activeVacation.responsibilitiesRemoved = removal.failed.length === 0;
            activeVacation.responsibilitiesRemovalFailures = removal.failed;
            if (removal.failed.length === 0) {
                activeVacation.responsibilitiesRemovedAt = new Date().toISOString();
                console.log(`✅ تمت إزالة ${responsibilityAssignments.length} مسؤولية للمستخدم ${userId} خلال الإجازة`);
            } else {
                console.error(`⚠️ تعذرت إزالة ${removal.failed.length} مسؤولية للمستخدم ${userId}؛ ستتم إعادة المحاولة آليًا`);
            }
            if (!saveVacations(vacations)) {
                console.error(`⚠️ لم يتم حفظ حالة إزالة المسؤوليات للمستخدم ${userId}; ستعاد المحاولة من النسخة المحفوظة`);
            }
        } catch (error) {
            activeVacation.responsibilitiesRemoved = false;
            activeVacation.responsibilitiesRemovalFailures = responsibilityAssignments;
            saveVacations(vacations);
            console.error(`❌ فشل إزالة مسؤوليات المستخدم ${userId}؛ ستعاد المحاولة:`, error.message);
        }
    }
    
    console.log(`✅ تم حفظ بيانات الإجازة بنجاح`);

    return { success: true, vacation: activeVacation };
}

// دالة لحساب مدة الإجازة
function calculateVacationDuration(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffMs = end.getTime() - start.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return diffDays;
}

// دالة لإرسال إشعار للإدارة عند انتهاء الإجازة
async function notifyAdminsVacationEnded(client, guild, vacation, userId, reason, rolesRestored) {
    try {
        const settings = getSettings();
        if (!settings.notificationMethod || !settings.approverType) {
            console.log('⚠️ إعدادات الإشعارات غير مكتملة، لن يتم إرسال إشعار للإدارة');
            return;
        }

        const user = await client.users.fetch(userId).catch(() => null);
        const duration = calculateVacationDuration(vacation.startDate, vacation.endDate);
        const actualEndDate = new Date();

        // حساب مدة الإجازة بدقة (أيام، ساعات، دقائق، ثواني)
        const startTime = new Date(vacation.startDate).getTime();
        const endTime = actualEndDate.getTime();
        const totalMs = endTime - startTime;

        const totalSeconds = Math.floor(totalMs / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        let durationText = '';
        if (days > 0) {
            durationText += `${days}d `;
        }
        if (hours > 0) {
            durationText += `${hours}h `;
        }
        if (minutes > 0) {
            durationText += `${minutes}m `;
        }
        if (seconds > 0 || durationText === '') {
            durationText += `${seconds}s`;
        }
        durationText = durationText.trim();

        const embed = colorManager.createEmbed()
            .setTitle('Vacation')
            .setColor(colorManager.getColor('ended') || '#FFA500')
            .setDescription(`تم إنهاء إجازة العضو <@${userId}> بنجاح واستعادة صلاحياته.`)
            .addFields(
                { name: 'لإداري', value: `<@${userId}>`, inline: true },
                { name: 'المدة', value: `___${durationText}___`, inline: true },
                { name: 'الحالة', value: reason || 'غير محدد', inline: false },
                { name: 'الرولات', value: rolesRestored.map(id => `<@&${id}>`).join(' ') || '`لا توجد`', inline: false },
                { name: 'البدء', value: `<t:${Math.floor(new Date(vacation.startDate).getTime() / 1000)}:f>`, inline: true },
                { name: 'الانتهاء', value: `<t:${Math.floor(actualEndDate.getTime() / 1000)}:f>`, inline: true }
            )
            .setThumbnail(user ? user.displayAvatarURL({ size: 128 }) : null)
            .setFooter({ text: 'Space' })
            .setTimestamp();

        if (user) {
            embed.setAuthor({
                name: user.tag,
                iconURL: user.displayAvatarURL({ size: 128 })
            });
        }

        // إرسال الإشعار حسب طريقة الإشعار المحددة
        if (settings.notificationMethod === 'channel' && settings.notificationChannel) {
            const channel = await client.channels.fetch(settings.notificationChannel).catch(() => null);
            if (channel) {
                await channel.send({ embeds: [embed] });
                console.log(`✅ تم إرسال إشعار انتهاء إجازة ${userId} للقناة ${channel.name}`);
            }
        } else if (settings.notificationMethod === 'dm') {
            const approvers = await getApprovers(guild, settings, []);
            for (const approver of approvers) {
                await approver.send({ embeds: [embed] }).catch(e => 
                    console.log(`فشل في إرسال إشعار انتهاء إجازة لـ ${approver.tag}: ${e.message}`)
                );
            }
            console.log(`✅ تم إرسال إشعار انتهاء إجازة ${userId} للمعتمدين`);
        }
    } catch (error) {
        console.error('❌ خطأ في إرسال إشعار انتهاء الإجازة للإدارة:', error);
    }
}

const activeVacationEndLocks = new Set();
async function endVacation(guild, client, userId, reason = 'انتهت فترة الإجازة.') {
    const lockKey = `${guild?.id || 'unknown'}:${userId}`;
    if (activeVacationEndLocks.has(lockKey)) {
        return { success: false, message: 'جارٍ إنهاء الإجازة لهذا المستخدم بالفعل.' };
    }
    activeVacationEndLocks.add(lockKey);
    try {
        return await performEndVacation(guild, client, userId, reason);
    } finally {
        activeVacationEndLocks.delete(lockKey);
    }
}

async function performEndVacation(guild, client, userId, reason = 'انتهت فترة الإجازة.') {
    try {
        const vacations = readJson(vacationsPath);
        const vacation = vacations.active?.[userId];

        if (!vacation) {
            return { success: false, message: 'لا توجد إجازة نشطة لهذا المستخدم.' };
        }

        if (!guild) {
            return { success: false, message: 'لم يتم توفير سياق الخادم.' };
        }

        console.log(`🔧 بدء عملية إنهاء إجازة المستخدم ${userId}`);
        console.log(`📊 بيانات الإجازة الكاملة:`, JSON.stringify(vacation, null, 2));

        // استخدام البيانات المحفوظة في JSON
        const savedMemberData = vacation.memberData;
        const savedRolesData = vacation.rolesData || [];

        console.log(`📊 بيانات العضو المحفوظة في JSON:`);
        console.log(`- ID: ${savedMemberData?.id || userId}`);
        console.log(`- الاسم: ${savedMemberData?.tag || 'غير محفوظ'}`);
        console.log(`- العرض: ${savedMemberData?.displayName || 'غير محفوظ'}`);
        console.log(`📊 بيانات الرولات المحفوظة: ${savedRolesData.length} رول`);

        let member = null;
        let memberNotFound = false;
        try {
            member = await fetchGuildMemberById(guild, userId);
        } catch (error) {
            if (isUnknownMemberError(error)) {
                memberNotFound = true;
                console.log(`⏳ العضو ${userId} غير موجود حاليًا في السيرفر؛ ستبقى الاستعادة معلقة حتى عودته.`);
            } else {
                console.error(`❌ تعذر جلب العضو ${userId} (لن نعدّه غائبًا بسبب خطأ مؤقت):`, error.message);
                return { success: false, message: `تعذر التحقق من العضو مؤقتًا: ${error.message}` };
            }
        }

        // لوج نهائي
        if (member) {
            console.log(`✅ نجح البحث النهائي: ${member.user.tag} (${member.id})`);
        } else {
            console.error(`❌ فشل البحث النهائي للعضو ${userId}`);
        }

        let rolesRestored = [];
        let deletedRoles = [];

        // استخدام removedRoles من بيانات الإجازة
        let rolesToRestore = [];
        
        if (vacation.removedRoles && Array.isArray(vacation.removedRoles) && vacation.removedRoles.length > 0) {
            rolesToRestore = vacation.removedRoles;
            console.log(`✅ تم العثور على ${rolesToRestore.length} رول في removedRoles`);
        } else if (vacation.rolesData && Array.isArray(vacation.rolesData) && vacation.rolesData.length > 0) {
            // بديل: استخدام rolesData إذا لم يكن removedRoles موجوداً
            rolesToRestore = vacation.rolesData.map(r => r.id);
            console.log(`✅ تم استخدام rolesData كبديل: ${rolesToRestore.length} رول`);
        } else {
            console.warn(`⚠️ لا توجد بيانات رولات للاستعادة!`);
        }

        const responsibilitiesToRestore = Array.isArray(vacation.responsibilityAssignments)
            ? vacation.responsibilityAssignments
            : [];
        let rolesPendingRetry = [];
        let responsibilityPendingRetry = [];

        console.log(`📋 معرفات الرولات للاستعادة: ${rolesToRestore.join(', ')}`);

        if (rolesToRestore.length > 0 || responsibilitiesToRestore.length > 0) {
            if (memberNotFound) {
                console.warn(`⚠️ العضو غير موجود، حفظ الرولات والمسؤوليات للاستعادة المعلقة`);

                if (!vacations.pendingRestorations) {
                    vacations.pendingRestorations = {};
                }

                vacations.pendingRestorations[userId] = {
                    guildId: guild.id,
                    roleIds: rolesToRestore,
                    responsibilityAssignments: responsibilitiesToRestore,
                    reason: reason,
                    vacationData: vacation,
                    savedAt: new Date().toISOString(),
                    lastAttempt: new Date().toISOString(),
                    nextAttemptAt: Date.now() + 120000
                };

                console.log(`💾 تم حفظ ${rolesToRestore.length} رول و${responsibilitiesToRestore.length} مسؤولية للاستعادة المعلقة`);

                // تتم إعادة المحاولة بهدوء عبر الفحص الدوري أو عند عودة العضو للسيرفر.
            } else if (member) {
                console.log(`👤 العضو موجود، بدء استعادة ${rolesToRestore.length} رول...`);

                // حدّث المسؤولية أولاً؛ حدث guildMemberUpdate الناتج عن إضافة
                // الرول يقرأ هذه البيانات فوراً، وإلا سيعتبر الرول مضافاً يدوياً.
                const responsibilityResult = await restoreUserResponsibilities(userId, responsibilitiesToRestore);
                responsibilityPendingRetry = responsibilityResult.failed;
                if (responsibilityPendingRetry.length > 0) {
                    console.warn(`⚠️ تعذرت استعادة ${responsibilityPendingRetry.length} مسؤولية للمستخدم ${userId}; ستبقى معلقة للمحاولة مرة أخرى.`);
                }
                const failedResponsibilityNames = new Set(responsibilityPendingRetry.map(item => item.name));
                const blockedRoleIds = new Set(
                    responsibilitiesToRestore
                        .filter(item => failedResponsibilityNames.has(item.name))
                        .flatMap(item => item.roleIds || [])
                        .map(String)
                );

                const validRoles = [];
                const alreadyHasRoles = [];

                for (const roleId of rolesToRestore) {
                    if (blockedRoleIds.has(String(roleId))) {
                        rolesPendingRetry.push(roleId);
                        continue;
                    }
                    try {
                        let role = guild.roles.cache.get(roleId);

                        if (!role) {
                            try {
                                role = await guild.roles.fetch(roleId);
                            } catch (fetchError) {
                                const roleCode = Number(fetchError?.code ?? fetchError?.rawError?.code);
                                if (roleCode === 10011 || Number(fetchError?.status) === 404) {
                                    console.warn(`⚠️ الرول ${roleId} غير موجود؛ تمت إزالته من بيانات الاستعادة.`);
                                    deletedRoles.push(roleId);
                                    continue;
                                }
                                throw fetchError;
                            }
                        }

                        if (role) {
                            console.log(`🔍 فحص الرول: ${role.name} (${roleId})`);

                            if (!member.roles.cache.has(roleId)) {
                                roleProtection.addToAutoRestoreIgnore(member.id, roleId);
                                roleProtection.trackBotRestoration(guild.id, member.id, roleId);
                                validRoles.push(roleId);
                                console.log(`➕ سيتم استعادة: ${role.name}`);
                            } else {
                                alreadyHasRoles.push(roleId);
                                console.log(`✓ العضو يمتلك الرول بالفعل: ${role.name}`);
                            }
                        } else {
                            deletedRoles.push(roleId);
                        }
                    } catch (roleError) {
                        console.error(`❌ خطأ في الرول ${roleId}:`, roleError.message);
                        if (!deletedRoles.includes(roleId)) rolesPendingRetry.push(roleId);
                    }
                }

                if (validRoles.length > 0) {
                    rolesPendingRetry = [...new Set([...rolesPendingRetry, ...validRoles])];
                    console.log(`🔄 استعادة ${validRoles.length} رول...`);
                    try {
                        // انتظار قصير للتأكد من تسجيل الحماية
                        await new Promise(resolve => setTimeout(resolve, 200));
                        
                        await member.roles.add(validRoles, 'إعادة لرولات بعد انتهاء الإجازة');
                        rolesRestored = [...validRoles];
                        rolesPendingRetry = rolesPendingRetry.filter(roleId => !validRoles.includes(roleId));
                        console.log(`✅ تمت إضافة ${rolesRestored.length}/${validRoles.length} رول بنجاح`);
                    } catch (addError) {
                        console.error(`❌ فشل في إضافة الرولات:`, addError.message);
                    }
                } else if (alreadyHasRoles.length > 0) {
                    rolesRestored = [...alreadyHasRoles];
                    console.log(`ℹ️ العضو يمتلك ${alreadyHasRoles.length} رول مسبقاً`);
                }

                rolesRestored = [...new Set([...rolesRestored, ...alreadyHasRoles])];

                console.log(`📊 النتيجة النهائية: ${rolesRestored.length} مستعاد، ${deletedRoles.length} محذوف`);
            }
        } else {
            console.log(`ℹ️ لا توجد رولات أو مسؤوليات محفوظة للاستعادة للمستخدم ${userId}.`);
        }

        if (!memberNotFound && (rolesPendingRetry.length > 0 || responsibilityPendingRetry.length > 0)) {
            if (!vacations.pendingRestorations) vacations.pendingRestorations = {};
            vacations.pendingRestorations[userId] = {
                guildId: guild.id,
                roleIds: rolesPendingRetry,
                responsibilityAssignments: responsibilityPendingRetry,
                reason,
                vacationData: vacation,
                savedAt: new Date().toISOString(),
                lastAttempt: new Date().toISOString(),
                nextAttemptAt: Date.now() + 120000
            };
        } else if (!memberNotFound && vacations.pendingRestorations?.[userId]) {
            delete vacations.pendingRestorations[userId];
        }

        // إزالة من الإجازات النشطة والطلبات المعلقة للإنهاء
        delete vacations.active[userId];
        if (vacations.pendingTermination?.[userId]) {
            delete vacations.pendingTermination[userId];
        }

        const saveResult = saveVacations(vacations);
        if (!saveResult) {
            console.error('❌ فشل في حفظ ملف الإجازات بعد الإنهاء');
            return { success: false, message: 'فشل في حفظ البيانات' };
        }

        console.log(`💾 تم حفظ إنهاء إجازة المستخدم ${userId} في ملف JSON`);

        // إرسال رسالة للمستخدم باستخدام البيانات المحفوظة
        if (!memberNotFound || savedMemberData) {
            try {
                const user = await client.users.fetch(userId).catch(() => null);

                let rolesText = '*لا توجد رولات*';
                let detailsText = '';

                // استخدام البيانات المحفوظة في JSON
                if (savedRolesData && savedRolesData.length > 0) {
                    const uniqueRolesRestored = [...new Set(rolesRestored)];
                    const roleTexts = [];

                    for (const roleData of savedRolesData) {
                        const wasRestored = uniqueRolesRestored.includes(roleData.id);
                        roleTexts.push(`${wasRestored ? '✅' : '⏳'} **${roleData.name}**`);
                    }

                    rolesText = roleTexts.length > 0 ? roleTexts.join('\n') : '*جميع الرولات محذوفه *';
                    
                    if (memberNotFound) {
                        // المستخدم غير موجود في السيرفر
                        detailsText = `**📦 تم حفظ ${savedRolesData.length} رول للاستعادة عند عودتك**`;
                        if (deletedRoles.length > 0) {
                            detailsText += `\n⚠️ **${deletedRoles.length} رول محذوف من السيرفر**`;
                        }
                    } else {
                        // المستخدم موجود في السيرفر
                        detailsText = `** Saved : ${savedRolesData.length} | Restored : ${uniqueRolesRestored.length}**`;
                        if (deletedRoles.length > 0) {
                            detailsText += ` **| Deleted : ${deletedRoles.length}**`;
                        }
                    }
                } else {
                    detailsText = 'لا توجد بيانات رولات محفوظة';
                }

                const embed = new EmbedBuilder()
                    .setTitle('Vacation Ended')
                    .setColor(colorManager.getColor('ended') || '#FFA500')
                    .setDescription(memberNotFound ? 
                        `**تم إنهاء إجازتك**\n\nستتم استعادة رولاتك تلقائياً عند عودتك للسيرفر.` : 
                        `**انتهت إجازتك . مرحباً بعودتك**`)
                        .addFields(
                        { name: 'Alert', value: reason },
                        { name: 'Roles', value: rolesText },
                        { name: 'Detaila', value: detailsText || '*لا توجد تفاصيل*' }, )
                .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1468175299601633364/info_1.png?ex=6983104c&is=6981becc&hm=e5ec42e46368e60486eb8d9ec9289affbba2d16971897b9c60322179fd2db47c&')       
                    .setTimestamp();
                if (user) {
                    await user.send({ embeds: [embed] });
                    console.log(`📧 تم إرسال رسالة انتهاء الإجازة للمستخدم ${user.tag} (${memberNotFound ? 'غير موجود في السيرفر' : 'موجود في السيرفر'})`);
                } else if (savedMemberData) {
                    console.log(`📧 لم نتمكن من إرسال رسالة للمستخدم ${savedMemberData.tag} - حساب Discord غير موجود`);
                }

            } catch (dmError) {
                console.error(`❌ فشل في إرسال رسالة DM للمستخدم ${userId}:`, dmError.message);
            }
        } else {
            console.log(`⚠️ تم تخطي إرسال رسالة DM - لا توجد بيانات للمستخدم`);
        }

        // إرسال إشعار للإدارة
        try {
            await notifyAdminsVacationEnded(client, guild, vacation, userId, reason, rolesRestored);
        } catch (notifyError) {
            console.error('❌ فشل في إرسال إشعار انتهاء الإجازة للإدارة:', notifyError);
        }

        console.log(`🎉 تم إنهاء إجازة المستخدم ${userId} بنجاح`);
        const vacationsToClean = readJson(vacationsPath);

        if (vacationsToClean.active && vacationsToClean.active[userId]) {

            delete vacationsToClean.active[userId];

        }

        if (vacationsToClean.pendingTermination && vacationsToClean.pendingTermination[userId]) {

            delete vacationsToClean.pendingTermination[userId];

        }

        saveVacations(vacationsToClean);
        return { success: true, vacation, rolesRestored };

    } catch (error) {
        console.error(`💥 خطأ عام في إنهاء إجازة المستخدم ${userId}:`, error);
        return { success: false, message: `خطأ في إنهاء الإجازة: ${error.message}` };
    }
}

const pendingRestorationLocks = new Set();
async function attemptPendingRestoration(guild, client, userId, pendingData, vacations) {
    const lockKey = `${guild.id}:${userId}`;
    if (pendingRestorationLocks.has(lockKey)) return { done: false, skipped: true };
    pendingRestorationLocks.add(lockKey);
    try {
        return await performPendingRestoration(guild, client, userId, pendingData, vacations);
    } finally {
        pendingRestorationLocks.delete(lockKey);
    }
}

async function performPendingRestoration(guild, client, userId, pendingData, vacations) {
    const now = Date.now();
    if (Number(pendingData.nextAttemptAt) > now) return { done: false, skipped: true };

    let member;
    try {
        member = await fetchGuildMemberById(guild, userId);
    } catch (error) {
        pendingData.lastAttempt = new Date().toISOString();
        pendingData.nextAttemptAt = now + getRetryDelayMs(error, 120000);
        pendingData.lastError = error.message;
        saveVacations(vacations);
        if (isUnknownMemberError(error)) {
            console.log(`⏳ العضو ${userId} غير موجود؛ تم تأجيل فحص الاستعادة حتى عودته.`);
        } else {
            console.warn(`⚠️ تعذر جلب العضو ${userId} مؤقتًا؛ إعادة المحاولة بعد ${Math.ceil((pendingData.nextAttemptAt - now) / 1000)} ثانية: ${error.message}`);
        }
        return { done: false, notFound: isUnknownMemberError(error), error };
    }

    const failedRoles = [];
    const restoredRoles = [];
    const responsibilityAssignments = Array.isArray(pendingData.responsibilityAssignments)
        ? pendingData.responsibilityAssignments
        : [];
    let failedResponsibilities = [];
    try {
        // يجب تحديث المسؤولية قبل إضافة الرول؛ حماية الرولات تعتمد على هذه
        // البيانات أثناء حدث guildMemberUpdate الناتج عن الإضافة.
        failedResponsibilities = (await restoreUserResponsibilities(userId, responsibilityAssignments)).failed;
    } catch (error) {
        failedResponsibilities = responsibilityAssignments;
        console.error(`❌ فشل في استعادة مسؤوليات العضو ${userId}:`, error.message);
    }
    const failedResponsibilityNames = new Set(failedResponsibilities.map(item => item.name));
    const blockedRoleIds = new Set(
        responsibilityAssignments
            .filter(item => failedResponsibilityNames.has(item.name))
            .flatMap(item => item.roleIds || [])
            .map(String)
    );

    for (const roleId of Array.isArray(pendingData.roleIds) ? pendingData.roleIds : []) {
        if (blockedRoleIds.has(String(roleId))) {
            failedRoles.push(roleId);
            continue;
        }
        try {
            if (member.roles.cache.has(roleId)) {
                restoredRoles.push(roleId);
                continue;
            }
            let role = guild.roles.cache.get(roleId);
            if (!role) {
                try {
                    role = await guild.roles.fetch(roleId);
                } catch (error) {
                    const roleCode = Number(error?.code ?? error?.rawError?.code);
                    if (roleCode === 10011 || Number(error?.status) === 404) {
                        console.warn(`⚠️ الرول ${roleId} حُذف من السيرفر؛ تمت إزالة الرول من قائمة الاستعادة.`);
                        continue;
                    }
                    throw error;
                }
            }
            if (!role) continue;

            roleProtection.addToAutoRestoreIgnore(member.id, roleId);
            roleProtection.trackBotRestoration(guild.id, member.id, roleId);
            await member.roles.add(roleId, `استعادة رول من إجازة معلقة`);
            restoredRoles.push(roleId);
        } catch (error) {
            failedRoles.push(roleId);
            console.error(`❌ فشل في استعادة الرول ${roleId} للعضو ${userId}:`, error.message);
        }
    }

    pendingData.roleIds = failedRoles;
    pendingData.responsibilityAssignments = failedResponsibilities;
    pendingData.lastAttempt = new Date().toISOString();
    pendingData.lastError = failedRoles.length || failedResponsibilities.length ? 'بعض عناصر الاستعادة لم تنجح' : null;

    if (failedRoles.length === 0 && failedResponsibilities.length === 0) {
        delete vacations.pendingRestorations[userId];
        if (!saveVacations(vacations)) {
            console.error(`❌ تعذر حفظ اكتمال الاستعادة للعضو ${userId}؛ ستعاد المحاولة بأمان.`);
            return { done: false, restoredRoles };
        }
        console.log(`✅ اكتملت استعادة الرولات والمسؤوليات للعضو ${userId}.`);
        try {
            await notifyAdminsVacationEnded(
                client,
                guild,
                pendingData.vacationData,
                userId,
                `${pendingData.reason || 'انتهت الإجازة'} (تمت الاستعادة التلقائية)`,
                restoredRoles
            );
        } catch (error) {
            console.error('❌ فشل في إرسال إشعار اكتمال الاستعادة:', error.message);
        }
        return { done: true, restoredRoles };
    }

    pendingData.nextAttemptAt = Date.now() + 120000;
    pendingData.failureReasons = [
        ...failedRoles.map(roleId => ({ type: 'role', id: roleId })),
        ...failedResponsibilities.map(item => ({ type: 'responsibility', name: item.name }))
    ];
    if (!saveVacations(vacations)) {
        console.error(`❌ تعذر حفظ عناصر الاستعادة الفاشلة للعضو ${userId}.`);
    }
    console.warn(`⚠️ ما زال للعضو ${userId} ${failedRoles.length} رول و${failedResponsibilities.length} مسؤولية؛ ستتم إعادة المحاولة لاحقًا.`);
    return { done: false, restoredRoles };
}

const activeVacationChecks = new Set();
async function checkVacations(client) {
    const checkKey = client?.user?.id || 'default';
    if (activeVacationChecks.has(checkKey)) return;
    activeVacationChecks.add(checkKey);

    try {
        const vacations = readJson(vacationsPath);
        if (!vacations.active || typeof vacations.active !== 'object') vacations.active = {};
        if (!vacations.pendingRestorations || typeof vacations.pendingRestorations !== 'object') vacations.pendingRestorations = {};

        const now = Date.now();
        let vacationDataChanged = false;
        const guildLookups = new Map();
        const fetchGuildOnce = async (guildId) => {
            if (!guildLookups.has(guildId)) {
                const cachedGuild = client.guilds.cache.get(guildId);
                guildLookups.set(guildId, cachedGuild || await client.guilds.fetch(guildId).catch(() => null));
            }
            return guildLookups.get(guildId);
        };

        // Retry responsibility removal if an approval was partially interrupted.
        for (const [userId, vacation] of Object.entries(vacations.active)) {
            const assignments = Array.isArray(vacation.responsibilityAssignments) ? vacation.responsibilityAssignments : [];
            if (!assignments.length || vacation.responsibilitiesRemoved || Number(vacation.responsibilityRemovalRetryAt) > now) continue;
            try {
                const removal = await removeUserFromResponsibilities(userId, assignments);
                vacation.responsibilitiesRemovalFailures = removal.failed;
                vacation.responsibilitiesRemoved = removal.failed.length === 0;
                vacation.responsibilityRemovalRetryAt = removal.failed.length ? now + 120000 : null;
                if (vacation.responsibilitiesRemoved) vacation.responsibilitiesRemovedAt = new Date().toISOString();
                vacationDataChanged = true;
                if (removal.failed.length) {
                    console.warn(`⚠️ تعذرت إزالة ${removal.failed.length} مسؤولية للمستخدم ${userId}; ستعاد المحاولة لاحقًا.`);
                } else {
                    console.log(`✅ اكتملت إزالة مسؤوليات المستخدم ${userId} للإجازة.`);
                }
            } catch (error) {
                vacation.responsibilityRemovalRetryAt = now + getRetryDelayMs(error, 120000);
                vacationDataChanged = true;
                console.error(`❌ تعذر تحديث مسؤوليات الإجازة للمستخدم ${userId}:`, error.message);
            }
        }
        if (vacationDataChanged && !saveVacations(vacations)) {
            console.error('❌ تعذر حفظ حالة مسؤوليات الإجازات بعد إعادة المحاولة.');
        }

        const expiredUsers = [];
        for (const [userId, vacation] of Object.entries(vacations.active)) {
            if (!vacation.endDate) continue;
            const endDate = new Date(vacation.endDate).getTime();
            if (Number.isFinite(endDate) && now >= endDate) expiredUsers.push(userId);
        }

        for (const userId of expiredUsers) {
            const vacation = vacations.active[userId];
            if (!vacation) continue;
            if (Number(vacation.restorationRetryAt) > Date.now()) continue;
            if (Number(vacation.guildRetryAt) > now) continue;
            if (!vacation.guildId) {
                console.error(`❌ لا يوجد معرف سيرفر في بيانات إجازة ${userId}`);
                continue;
            }

            try {
                const guild = await fetchGuildOnce(vacation.guildId);
                if (!guild) {
                    vacation.guildRetryAt = now + 300000;
                    saveVacations(vacations);
                    console.warn(`⚠️ لا يمكن الوصول إلى سيرفر الإجازة للمستخدم ${userId}; ستعاد المحاولة بعد 5 دقائق.`);
                    continue;
                }
                const result = await endVacation(guild, client, userId, 'Auto');
                if (result.success) {
                    console.log(`✅ تم إنهاء إجازة المستخدم ${userId}; ${result.rolesRestored?.length || 0} رول أُعيد، وأي تعذر محفوظ للاستعادة.`);
                } else {
                    vacation.restorationRetryAt = Date.now() + 120000;
                    vacation.restorationLastError = result.message;
                    saveVacations(vacations);
                    console.error(`❌ فشل في إنهاء إجازة المستخدم ${userId}: ${result.message}`);
                }
            } catch (error) {
                console.error(`💥 خطأ في معالجة إنهاء إجازة المستخدم ${userId}:`, error.message);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const pendingIds = Object.keys(vacations.pendingRestorations);
        if (pendingIds.length) console.log(`🔍 فحص ${pendingIds.length} استعادة معلقة.`);
        for (const userId of pendingIds) {
            const pendingData = vacations.pendingRestorations[userId];
            if (!pendingData || Number(pendingData.nextAttemptAt) > Date.now()) continue;
            if (!pendingData.guildId) {
                console.error(`❌ لا يوجد معرف سيرفر في بيانات الاستعادة المعلقة للمستخدم ${userId}`);
                continue;
            }
            try {
                const guild = await fetchGuildOnce(pendingData.guildId);
                if (!guild) {
                    pendingData.nextAttemptAt = Date.now() + 600000;
                    pendingData.lastAttempt = new Date().toISOString();
                    saveVacations(vacations);
                    console.warn(`⚠️ لا يمكن الوصول لسيرفر الاستعادة للمستخدم ${userId}; تأجيل الفحص 10 دقائق.`);
                    continue;
                }
                await attemptPendingRestoration(guild, client, userId, pendingData, vacations);
            } catch (error) {
                pendingData.lastAttempt = new Date().toISOString();
                pendingData.nextAttemptAt = Date.now() + getRetryDelayMs(error, 120000);
                pendingData.lastError = error.message;
                saveVacations(vacations);
                console.error(`❌ خطأ في معالجة استعادة معلقة للعضو ${userId}; ستعاد المحاولة بعد التهدئة:`, error.message);
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    } catch (error) {
        console.error('💥 خطأ عام في فحص الإجازات:', error);
    } finally {
        activeVacationChecks.delete(checkKey);
    }
}

async function getApprovers(guild, settings, botOwners) {
    const approverIds = new Set();
    if (settings.approverType === 'owners') {
        botOwners.forEach(id => approverIds.add(id));
    } else if (settings.approverType === 'role') {
        for (const roleId of settings.approverTargets) {
            const role = await guild.roles.fetch(roleId).catch(() => null);
            if (role) role.members.forEach(m => approverIds.add(m.id));
        }
    } else if (settings.approverType === 'responsibility') {
        const responsibilities = readJson(responsibilitiesPath);
        for (const respName of settings.approverTargets) {
            const respData = responsibilities[respName];
            if (respData?.responsibles && respData.responsibles.length > 0) {
                respData.responsibles.forEach(id => approverIds.add(id));
            }
        }
    }

    const approvers = [];
    for (const id of approverIds) {
        const user = await guild.client.users.fetch(id).catch(() => null);
        if (user) approvers.push(user);
    }
    return approvers;
}

async function isUserAuthorizedApprover(userId, guild, settings, botOwners) {
    try {
        // ✅ الأونر يتجاوز كل الشروط

if (botOwners && botOwners.includes(userId)) {

    return true;

}
        // التحقق من أن إعدادات الإجازات محددة
        if (!settings || !settings.approverType) {
            console.log(`⚠️ إعدادات الإجازات غير مكتملة للتحقق من صلاحية المستخدم ${userId}`);
            return false;
        }

        // التحقق من نوع المعتمد
        if (settings.approverType === 'owners') {
            const isOwner = botOwners.includes(userId);
            console.log(`🔍 فحص صلاحية المالك للمستخدم ${userId}: ${isOwner ? 'مُعتمد' : 'غير مُعتمد'}`);
            return isOwner;
        } 
        else if (settings.approverType === 'role') {
            if (!settings.approverTargets || settings.approverTargets.length === 0) {
                console.log('⚠️ لم يتم تحديد أدوار المعتمدين');
                return false;
            }

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                console.log(`⚠️ لا يمكن العثور على العضو ${userId} في الخادم`);
                return false;
            }

            const hasRequiredRole = settings.approverTargets.some(roleId => member.roles.cache.has(roleId));
            console.log(`🔍 فحص صلاحية الدور للمستخدم ${userId}: ${hasRequiredRole ? 'مُعتمد' : 'غير مُعتمد'}`);
            return hasRequiredRole;
        }
        else if (settings.approverType === 'responsibility') {
            if (!settings.approverTargets || settings.approverTargets.length === 0) {
                console.log('⚠️ لم يتم تحديد مسؤوليات المعتمدين');
                return false;
            }

            const responsibilities = readJson(responsibilitiesPath);
            for (const respName of settings.approverTargets) {
                const respData = responsibilities[respName];
                if (respData?.responsibles && respData.responsibles.includes(userId)) {
                    console.log(`🔍 فحص صلاحية المسؤولية للمستخدم ${userId}: مُعتمد (المسؤولية: ${respName})`);
                    return true;
                }
            }
            console.log(`🔍 فحص صلاحية المسؤولية للمستخدم ${userId}: غير مُعتمد`);
            return false;
        }

        console.log(`⚠️ نوع معتمد غير مدعوم: ${settings.approverType}`);
        return false;

    } catch (error) {
        console.error(`❌ خطأ في فحص صلاحية المستخدم ${userId}:`, error);
        return false;
    }
}

// دالة للتعامل مع عودة العضو للسيرفر
async function handleMemberJoin(member) {
    try {
        const vacations = readJson(vacationsPath);
        const pendingData = vacations.pendingRestorations?.[member.id];
        if (!pendingData) {
            console.log(`📥 لا توجد استعادة معلقة للعضو ${member.user.tag}`);
            return;
        }
        if (pendingData.guildId !== member.guild.id) {
            console.log(`⚠️ عدم تطابق السيرفر للاستعادة المعلقة للعضو ${member.user.tag}`);
            return;
        }

        // وصول العضو حدث موثوق؛ لا ننتظر مؤقت التهدئة المحفوظ من محاولة سابقة.
        pendingData.nextAttemptAt = 0;
        console.log(`🔄 استعادة الرولات والمسؤوليات المعلقة للعضو ${member.user.tag}`);
        const result = await attemptPendingRestoration(member.guild, member.client, member.id, pendingData, vacations);
        if (!result.done) return;

        try {
            const roleNames = (pendingData.vacationData?.rolesData || [])
                .filter(role => result.restoredRoles.includes(role.id))
                .map(role => `• ${role.name}`);
            const responsibilityNames = (pendingData.vacationData?.responsibilityAssignments || [])
                .map(item => `• ${item.name}`);
            const details = [...roleNames, ...responsibilityNames];
            const embed = new EmbedBuilder()
                .setTitle('Welcome Back!')
                .setColor(colorManager.getColor('ended') || '#FFA500')
                .setDescription('انتهت إجازتك أثناء غيابك، وتمت استعادة الرولات والمسؤوليات المحفوظة.')
                .addFields({ name: 'ما تمت استعادته', value: details.join('\n').slice(0, 1024) || 'لا توجد عناصر تحتاج إلى استعادة.' })
                .setTimestamp();
            await member.user.send({ embeds: [embed] }).catch(error => {
                console.log(`تعذر إرسال رسالة استعادة للعضو ${member.id}: ${error.message}`);
            });
        } catch (dmError) {
            console.error(`❌ خطأ في إرسال رسالة استعادة للعضو ${member.id}:`, dmError.message);
        }
    } catch (error) {
        console.error('❌ خطأ في handleMemberJoin للإجازات:', error);
    }
}

// دالة للتعامل مع مغادرة العضو للسيرفر
async function handleMemberLeave(member) {
    try {
        // يمكن إضافة منطق لحفظ حالة الإجازة هنا
        console.log(`📤 تم فحص إجازات العضو ${member.user.tag} عند مغادرة السيرفر`);
    } catch (error) {
        console.error('❌ خطأ في handleMemberLeave للإجازات:', error);
    }
}

module.exports = {
    getSettings,
    isUserOnVacation,
    approveVacation,
    endVacation,
    checkVacations,
    getApprovers,
    isUserAuthorizedApprover,
    saveVacations,
    readJson,
    calculateVacationDuration,
    notifyAdminsVacationEnded,
    roleProtection,
    handleMemberJoin,
    handleMemberLeave
};
