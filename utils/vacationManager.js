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
    try {
        fs.writeFileSync(vacationsPath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing vacations.json:', error);
        return false;
    }
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
    saveVacations(vacations);

    const guild = interaction.guild;
    if (!guild) return { success: false, message: 'Interaction did not originate from a guild.' };

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return { success: false, message: 'User not found in the guild.' };

    const adminRoles = readJson(adminRolesPath, []);
    console.log(`📋 Admin Roles from file: ${JSON.stringify(adminRoles)}`);

    const rolesToRemove = member.roles.cache.filter(role => adminRoles.includes(role.id));
    let actuallyRemovedRoleIds = [];

    try {
        if (rolesToRemove.size > 0) {
            console.log(`🔧 محاولة سحب ${rolesToRemove.size} دور إداري من المستخدم ${member.user.tag}`);
            console.log(`📋 الأدوار المراد سحبها: ${rolesToRemove.map(r => r.name).join(', ')}`);

            await member.roles.remove(rolesToRemove, 'سحب لرولات الإدارية بسبب الإجازة');
            actuallyRemovedRoleIds = rolesToRemove.map(role => role.id);
        } else {
            console.log(`⚠️ لا توجد أدوار إدارية لسحبها من المستخدم ${member.user.tag}`);
            // Check if member has any roles that are in adminRoles but maybe cache is stale
            const memberFetch = await guild.members.fetch(userId);
            const rolesToRemoveFetch = memberFetch.roles.cache.filter(role => adminRoles.includes(role.id));
            if (rolesToRemoveFetch.size > 0) {
                console.log(`🔧 [Retry] محاولة سحب ${rolesToRemoveFetch.size} دور إداري`);
                await memberFetch.roles.remove(rolesToRemoveFetch, 'سحب لرولات الإدارية بسبب الإجازة');
                actuallyRemovedRoleIds = rolesToRemoveFetch.map(role => role.id);
            }
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
        guildId: guild.id  // حفظ معرف السيرفر
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
        return { success: false, message: 'فشل في حفظ بيانات الإجازة' };
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

async function endVacation(guild, client, userId, reason = 'انتهت فترة الإجازة.') {
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

        // محاولة جلب العضو من السيرفر بـ 5 طرق موثوقة
        let member = null;
        let memberNotFound = false;

        try {
            console.log(`🔍 بدء البحث الشامل عن العضو ${userId}...`);
            
            // الطريقة 1: فحص الكاش أولاً (الأسرع)
            member = guild.members.cache.get(userId);
            if (member) {
                console.log(`✅ [طريقة 1 - كاش] تم العثور على ${member.user.tag}`);
            } else {
                console.log(`⏭️ [طريقة 1] العضو غير موجود في الكاش، جارٍ التجربة بطرق أخرى...`);
                
                // الطريقة 2: جلب مباشر بـ force
                try {
                    member = await guild.members.fetch({ user: userId, force: true });
                    console.log(`✅ [طريقة 2 - جلب مباشر] تم جلب ${member.user.tag}`);
                } catch (directError) {
                    console.log(`⏭️ [طريقة 2] فشل: ${directError.message}`);
                    
                    // الطريقة 3: تحديث كاش السيرفر بالكامل ثم البحث
                    try {
                        console.log(`🔄 [طريقة 3] تحديث كاش السيرفر الكامل...`);
                        await guild.members.fetch({ force: true, withPresences: false });
                        console.log(`✓ تم تحديث ${guild.members.cache.size} عضو`);
                        
                        member = guild.members.cache.get(userId);
                        if (member) {
                            console.log(`✅ [طريقة 3 - كاش محدث] العثور على ${member.user.tag}`);
                        } else {
                            console.log(`⏭️ [طريقة 3] العضو غير موجود بعد التحديث`);
                            
                            // الطريقة 4: جلب جميع الأعضاء والبحث يدوياً
                            try {
                                console.log(`🔄 [طريقة 4] جلب جميع الأعضاء...`);
                                const allMembers = await guild.members.fetch({ limit: 0 });
                                console.log(`✓ تم جلب ${allMembers.size} عضو`);
                                
                                member = allMembers.get(userId) || allMembers.find(m => m.id === userId);
                                if (member) {
                                    console.log(`✅ [طريقة 4 - جلب شامل] العثور على ${member.user.tag}`);
                                } else {
                                    console.log(`⏭️ [طريقة 4] العضو غير موجود في القائمة الشاملة`);
                                    
                                    // الطريقة 5: محاولة أخيرة عبر API مباشرة
                                    try {
                                        console.log(`🔄 [طريقة 5] محاولة API مباشرة...`);
                                        await new Promise(resolve => setTimeout(resolve, 1000)); // انتظار ثانية
                                        member = await guild.members.fetch(userId).catch(() => null);
                                        
                                        if (member) {
                                            console.log(`✅ [طريقة 5 - API] نجح الجلب: ${member.user.tag}`);
                                        } else {
                                            console.warn(`❌ [النتيجة النهائية] العضو ${userId} غير موجود في السيرفر بعد 5 محاولات`);
                                            memberNotFound = true;
                                        }
                                    } catch (apiError) {
                                        console.error(`❌ [طريقة 5] خطأ في API: ${apiError.message}`);
                                        memberNotFound = true;
                                    }
                                }
                            } catch (fetchAllError) {
                                console.error(`❌ [طريقة 4] خطأ في جلب الكل: ${fetchAllError.message}`);
                                memberNotFound = true;
                            }
                        }
                    } catch (cacheError) {
                        console.error(`❌ [طريقة 3] خطأ في تحديث الكاش: ${cacheError.message}`);
                        memberNotFound = true;
                    }
                }
            }
            
        } catch (error) {
            console.error(`💥 خطأ عام في البحث عن العضو ${userId}:`, error);
            memberNotFound = true;
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

        console.log(`📋 معرفات الرولات للاستعادة: ${rolesToRestore.join(', ')}`);

        if (rolesToRestore.length > 0) {
            if (memberNotFound) {
                console.warn(`⚠️ العضو غير موجود، حفظ للاستعادة المعلقة`);

                if (!vacations.pendingRestorations) {
                    vacations.pendingRestorations = {};
                }

                vacations.pendingRestorations[userId] = {
                    guildId: guild.id,
                    roleIds: rolesToRestore,
                    reason: reason,
                    vacationData: vacation,
                    savedAt: new Date().toISOString()
                };

                console.log(`💾 تم حفظ ${rolesToRestore.length} رول للاستعادة المعلقة`);

                // محاولة إضافية فورية بعد 10 ثوانٍ (بدلاً من الانتظار 5 دقائق)
                setTimeout(async () => {
                    try {
                        console.log(`🔄 محاولة فورية لاستعادة الرولات للعضو ${userId} بعد 10 ثوانٍ...`);
                        
                        // محاولة جلب العضو مرة أخرى
                        let retryMember = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
                        
                        if (!retryMember) {
                            await guild.members.fetch({ force: true });
                            retryMember = guild.members.cache.get(userId);
                        }

                        if (retryMember) {
                            console.log(`✅ تم العثور على العضو ${retryMember.user.tag} في المحاولة الفورية!`);
                            
                            // قراءة البيانات الحالية
                            const currentVacations = readJson(vacationsPath);
                            const pendingData = currentVacations.pendingRestorations?.[userId];

                            if (pendingData && pendingData.guildId === guild.id) {
                                const restoredRoles = [];
                                const failedRoles = [];

                                for (const roleId of pendingData.roleIds) {
                                    try {
                                        const role = await guild.roles.fetch(roleId).catch(() => null);

                                        if (role && !retryMember.roles.cache.has(roleId)) {
                                            roleProtection.addToAutoRestoreIgnore(retryMember.id, roleId);
                                            roleProtection.trackBotRestoration(guild.id, retryMember.id, roleId);

                                            await new Promise(resolve => setTimeout(resolve, 100));
                                            await retryMember.roles.add(roleId, `استعادة فورية بعد انتهاء الإجازة`);
                                            restoredRoles.push(roleId);
                                            console.log(`✅ تمت استعادة الرول ${role.name} في المحاولة الفورية`);
                                        } else if (role && retryMember.roles.cache.has(roleId)) {
                                            restoredRoles.push(roleId);
                                            console.log(`✓ العضو يمتلك الرول ${role.name} بالفعل`);
                                        } else {
                                            failedRoles.push(roleId);
                                        }
                                    } catch (error) {
                                        console.error(`❌ خطأ في استعادة الرول ${roleId}:`, error.message);
                                        failedRoles.push(roleId);
                                    }
                                }

                                // تحديث البيانات
                                if (failedRoles.length === 0) {
                                    delete currentVacations.pendingRestorations[userId];
                                    saveVacations(currentVacations);
                                    console.log(`✅ تمت استعادة جميع الرولات في المحاولة الفورية`);

                                    // إرسال إشعار
                                    await notifyAdminsVacationEnded(
                                        client, 
                                        guild, 
                                        pendingData.vacationData, 
                                        userId, 
                                        `${pendingData.reason} (استعادة فورية)`, 
                                        restoredRoles
                                    ).catch(e => console.error('❌ فشل الإشعار:', e.message));
                                } else {
                                    currentVacations.pendingRestorations[userId].roleIds = failedRoles;
                                    currentVacations.pendingRestorations[userId].lastAttempt = new Date().toISOString();
                                    saveVacations(currentVacations);
                                    console.log(`⚠️ ${failedRoles.length} رول فشلت في المحاولة الفورية`);
                                }
                            }
                        } else {
                            console.log(`⏳ العضو ${userId} لا يزال غير موجود في المحاولة الفورية`);
                        }
                    } catch (retryError) {
                        console.error(`❌ خطأ في المحاولة الفورية:`, retryError);
                    }
                }, 10000); // 10 ثوانٍ
            } else if (member) {
                console.log(`👤 العضو موجود، بدء استعادة ${rolesToRestore.length} رول...`);

                const validRoles = [];
                const alreadyHasRoles = [];

                for (const roleId of rolesToRestore) {
                    try {
                        let role = guild.roles.cache.get(roleId);

                        if (!role) {
                            try {
                                role = await guild.roles.fetch(roleId);
                            } catch (fetchError) {
                                console.warn(`⚠️ الرول ${roleId} غير موجود`);
                                deletedRoles.push(roleId);
                                continue;
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
                        deletedRoles.push(roleId);
                    }
                }

                if (validRoles.length > 0) {
                    console.log(`🔄 استعادة ${validRoles.length} رول...`);
                    try {
                        // انتظار قصير للتأكد من تسجيل الحماية
                        await new Promise(resolve => setTimeout(resolve, 200));
                        
                        await member.roles.add(validRoles, 'إعادة لرولات بعد انتهاء الإجازة');
                        rolesRestored = [...validRoles];
                        
                        // التحقق من نجاح الاستعادة
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        const verifyMember = await guild.members.fetch(userId);
                        const actuallyRestored = validRoles.filter(id => verifyMember.roles.cache.has(id));
                        
                        console.log(`✅ تم استعادة ${actuallyRestored.length}/${validRoles.length} رول بنجاح`);
                        rolesRestored = actuallyRestored;
                    } catch (addError) {
                        console.error(`❌ فشل في إضافة الرولات:`, addError);
                    }
                } else if (alreadyHasRoles.length > 0) {
                    rolesRestored = [...alreadyHasRoles];
                    console.log(`ℹ️ العضو يمتلك ${alreadyHasRoles.length} رول مسبقاً`);
                }

                console.log(`📊 النتيجة النهائية: ${rolesRestored.length} مستعاد، ${deletedRoles.length} محذوف`);
            }
        } else {
            console.warn(`⚠️ لا توجد رولات محفوظة للاستعادة!`);
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

async function checkVacations(client) {
    try {
        const vacations = readJson(vacationsPath);

        // التحقق من وجود بيانات الإجازات النشطة
        if (!vacations.active || Object.keys(vacations.active).length === 0) {
            return; // لا توجد إجازات نشطة للفحص
        }

        const now = Date.now();
        const expiredUsers = [];

        // جمع المستخدمين الذين انتهت إجازاتهم
        for (const userId in vacations.active) {
            const vacation = vacations.active[userId];
            if (!vacation.endDate) {
                console.warn(`⚠️ إجازة المستخدم ${userId} لا تحتوي على تاريخ انتهاء`);
                continue;
            }

            const endDate = new Date(vacation.endDate).getTime();
            if (isNaN(endDate)) {
                console.warn(`⚠️ تاريخ انتهاء إجازة المستخدم ${userId} غير صالح: ${vacation.endDate}`);
                continue;
            }

            if (now >= endDate) {
                expiredUsers.push(userId);
            }
        }

        // معالجة الإجازات المنتهية
        if (expiredUsers.length > 0) {
            console.log(`🕒 تم العثور على ${expiredUsers.length} إجازة منتهية`);

            for (const userId of expiredUsers) {
                try {
                    console.log(`⏰ جاري إنهاء إجازة المستخدم ${userId}...`);
                    
                    // جلب السيرفر من بيانات الإجازة
                    const vacation = vacations.active[userId];
                    const guildId = vacation.guildId;
                    
                    if (!guildId) {
                        console.error(`❌ لا يوجد معرف سيرفر في بيانات إجازة ${userId}`);
                        continue;
                    }
                    
                    const guild = await client.guilds.fetch(guildId).catch(() => null);
                    if (!guild) {
                        console.error(`❌ لا يمكن العثور على السيرفر ${guildId} للمستخدم ${userId}`);
                        continue;
                    }
                    
                    const result = await endVacation(guild, client, userId, 'Auto');

                    if (result.success) {
                        console.log(`✅ تم إنهاء إجازة المستخدم ${userId} تلقائياً بنجاح`);
                        console.log(`📋 تم استعادة ${result.rolesRestored.length} دور للمستخدم`);
                    } else {
                        console.error(`❌ فشل في إنهاء إجازة المستخدم ${userId}: ${result.message}`);
                    }
                } catch (error) {
                    console.error(`💥 خطأ في معالجة إنهاء إجازة المستخدم ${userId}:`, error);
                }

                // انتظار قصير بين العمليات لتجنب التحميل الزائد
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            console.log('🔄 انتهت معالجة جميع الإجازات المنتهية');
        }

        // التحقق من الاستعادات المعلقة والمحاولة مرة أخرى للأعضاء الموجودين (دائماً)
        if (vacations.pendingRestorations && Object.keys(vacations.pendingRestorations).length > 0) {
            console.log(`🔍 فحص الاستعادات المعلقة (${Object.keys(vacations.pendingRestorations).length} عضو)`);

            for (const userId in vacations.pendingRestorations) {
                const pendingData = vacations.pendingRestorations[userId];

                // جلب السيرفر من بيانات الاستعادة
                const guildId = pendingData.guildId;
                if (!guildId) {
                    console.error(`❌ لا يوجد معرف سيرفر في بيانات الاستعادة المعلقة للمستخدم ${userId}`);
                    continue;
                }
                
                const guild = await client.guilds.fetch(guildId).catch(() => null);
                if (!guild) {
                    console.error(`❌ لا يمكن العثور على السيرفر ${guildId} للمستخدم ${userId}`);
                    continue;
                }

                try {
                    // محاولة جلب العضو بطرق متعددة
                    let member = guild.members.cache.get(userId);
                    
                    if (!member) {
                        member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
                    }
                    
                    if (!member) {
                        await guild.members.fetch({ force: true });
                        member = guild.members.cache.get(userId);
                    }

                    if (member) {
                        console.log(`✅ العضو ${member.user.tag} موجود الآن - محاولة استعادة الرولات`);

                        const rolesRestored = [];
                        const rolesFailed = [];

                        for (const roleId of pendingData.roleIds) {
                            try {
                                const role = await guild.roles.fetch(roleId).catch(() => null);

                                if (role && !member.roles.cache.has(roleId)) {
                                    try {
                                        roleProtection.addToAutoRestoreIgnore(member.id, roleId);
                                        roleProtection.trackBotRestoration(guild.id, member.id, roleId);

                                        // انتظار قصير للتأكد من تسجيل الحماية
                                        await new Promise(resolve => setTimeout(resolve, 100));

                                        await member.roles.add(roleId, `استعادة رول من إجازة معلقة`);
                                        rolesRestored.push(roleId);
                                        console.log(`✅ تمت استعادة الرول ${role.name}`);
                                    } catch (addError) {
                                        rolesFailed.push(roleId);
                                        console.error(`❌ فشل في استعادة الرول ${role.name}:`, addError.message);
                                    }
                                } else if (!role) {
                                    rolesFailed.push(roleId);
                                }
                            } catch (error) {
                                console.error(`❌ خطأ في معالجة الرول ${roleId}:`, error.message);
                                rolesFailed.push(roleId);
                            }
                        }

                        if (rolesFailed.length === 0) {
                            // حذف الاستعادة المعلقة
                            delete vacations.pendingRestorations[userId];
                            saveVacations(vacations);
                            console.log(`✅ تمت استعادة جميع الرولات للعضو ${member.user.tag}`);

                            // إرسال إشعار
                            try {
                                await notifyAdminsVacationEnded(
                                    client, 
                                    guild, 
                                    pendingData.vacationData, 
                                    userId, 
                                    `${pendingData.reason} (تمت الاستعادة التلقائية)`, 
                                    rolesRestored
                                );
                            } catch (notifyError) {
                                console.error('❌ فشل في إرسال إشعار:', notifyError.message);
                            }
                        } else {
                            // تحديث بيانات الاستعادة المعلقة مع الفاشلين
                            pendingData.roleIds = rolesFailed;
                            pendingData.lastAttempt = new Date().toISOString();
                            pendingData.failureReasons = rolesFailed.map(id => ({ roleId: id, reason: 'فشل الاستعادة' })); // Add failure reason
                            saveVacations(vacations); // Save changes to pending restorations
                            console.log(`⚠️ ${rolesFailed.length} رول فشلت استعادتها، سيتم إعادة المحاولة لاحقاً.`);
                        }
                    } else {
                        console.log(`⏳ العضو ${userId} لا يزال غير موجود، سيتم التحقق لاحقاً.`);
                    }
                } catch (error) {
                    console.error(`❌ خطأ في معالجة استعادة معلقة للعضو ${userId}:`, error.message);
                }

                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

    } catch (error) {
        console.error('💥 خطأ عام في فحص الإجازات:', error);
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

        // التحقق من وجود استعادة معلقة لهذا العضو
        if (!vacations.pendingRestorations || !vacations.pendingRestorations[member.id]) {
            console.log(`📥 لا توجد استعادة معلقة للعضو ${member.user.tag}`);
            return;
        }

        const pendingRestoration = vacations.pendingRestorations[member.id];

        // التحقق من تطابق السيرفر
        if (pendingRestoration.guildId !== member.guild.id) {
            console.log(`⚠️ عدم تطابق السيرفر للاستعادة المعلقة للعضو ${member.user.tag}`);
            return;
        }

        console.log(`🔄 بدء استعادة الرولات المعلقة للعضو ${member.user.tag}`);
        console.log(`📋 عدد الرولات المراد استعادتها: ${pendingRestoration.roleIds.length}`);

        const rolesRestored = [];
        const rolesFailed = [];

        // معالجة كل رول
        for (const roleId of pendingRestoration.roleIds) {
            try {
                // البحث عن الرول في السيرفر
                let role = member.guild.roles.cache.get(roleId);

                if (!role) {
                    try {
                        role = await member.guild.roles.fetch(roleId);
                    } catch (fetchError) {
                        console.warn(`⚠️ الرول ${roleId} غير موجود في السيرفر`);
                        rolesFailed.push({ roleId, reason: 'الرول غير موجود' });
                        continue;
                    }
                }

                if (role) {
                    // التحقق من عدم امتلاك العضو للرول
                    if (!member.roles.cache.has(roleId)) {
                        // استخدام نظام الحماية
                        roleProtection.addToAutoRestoreIgnore(member.id, roleId);
                        roleProtection.trackBotRestoration(member.guild.id, member.id, roleId);

                        // إضافة الرول
                        await member.roles.add(roleId, `استعادة رول بعد العودة من الإجازة: ${pendingRestoration.reason}`);
                        rolesRestored.push(roleId);
                        console.log(`✅ تمت استعادة الرول: ${role.name} (${roleId})`);
                    } else {
                        console.log(`🔄 العضو يمتلك الرول ${role.name} بالفعل`);
                        rolesRestored.push(roleId);
                    }
                }
            } catch (roleError) {
                console.error(`❌ خطأ في استعادة الرول ${roleId}:`, roleError.message);
                rolesFailed.push({ roleId, reason: roleError.message });
            }
        }

        console.log(`📊 النتيجة: ${rolesRestored.length} مستعاد، ${rolesFailed.length} فشل`);

        // إذا كانت هناك رولات فشلت، احتفظ بها للمحاولة مرة أخرى
        if (rolesFailed.length > 0) {
            pendingRestoration.roleIds = rolesFailed.map(f => f.roleId);
            pendingRestoration.lastAttempt = new Date().toISOString();
            pendingRestoration.failureReasons = rolesFailed;
            saveVacations(vacations);
            console.log(`⚠️ تم الاحتفاظ بـ ${rolesFailed.length} رول فاشل للمحاولة مرة أخرى`);
        } else {
            // حذف الاستعادة المعلقة
            delete vacations.pendingRestorations[member.id];
            saveVacations(vacations);
            console.log(`✅ تم حذف الاستعادة المعلقة بنجاح`);
        }

        // إرسال رسالة للمستخدم
        if (rolesRestored.length > 0) {
            try {
                const vacation = pendingRestoration.vacationData;
                const rolesData = vacation.rolesData || [];

                let rolesText = '*لا توجد رولات*';
                if (rolesData.length > 0) {
                    const roleTexts = rolesData
                        .filter(rd => rolesRestored.includes(rd.id))
                        .map(rd => `✅ **${rd.name}**`);
                    rolesText = roleTexts.length > 0 ? roleTexts.join('\n') : '*جميع الرولات محذوفة*';
                }

                const embed = new EmbedBuilder()
                    .setTitle(' Welcome Back !')
                    .setColor(colorManager.getColor('ended') || '#FFA500')
                    .setDescription(`**انتهت إجازتك أثناء غيابك وتم استعادة رولاتك الآن**`)
                        .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1468175299601633364/info_1.png?ex=6983104c&is=6981becc&hm=e5ec42e46368e60486eb8d9ec9289affbba2d16971897b9c60322179fd2db47c&')
                    .addFields(
                        { name: 'Alert', value: pendingRestoration.reason },
                        { name: 'Roles', value: rolesText },
                        { name: 'Details', value: `**Restored : ${rolesRestored.length}${rolesFailed.length > 0 ? ` | Failed : ${rolesFailed.length}` : ''}**` }
                    )
                    .setTimestamp();

                await member.user.send({ embeds: [embed] }).catch(e => 
                    console.log(`فشل في إرسال رسالة للعضو: ${e.message}`)
                );
                console.log(`📧 تم إرسال رسالة استعادة للعضو ${member.user.tag}`);
            } catch (dmError) {
                console.error(`❌ خطأ في إرسال رسالة DM:`, dmError.message);
            }
        }

        // إرسال إشعار للإدارة
        if (rolesRestored.length > 0) {
            try {
                await notifyAdminsVacationEnded(
                    member.client, 
                    member.guild, 
                    pendingRestoration.vacationData, 
                    member.id, 
                    `${pendingRestoration.reason} (تمت الاستعادة عند العودة)`, 
                    rolesRestored
                );
            } catch (notifyError) {
                console.error('❌ فشل في إرسال إشعار للإدارة:', notifyError.message);
            }
        }

        console.log(`✅ تمت معالجة استعادة الإجازة للعضو ${member.user.tag}`);

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
