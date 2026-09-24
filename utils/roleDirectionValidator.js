function validateRoleDirection(action, targetRole, requestedRole, typeLabel = 'حرف') {
    if (!targetRole || !requestedRole) return { valid: true };

    const isDemotion = action === 'demotion';
    if (isDemotion && requestedRole.position >= targetRole.position) {
        return {
            valid: false,
            error: `لا يمكن التنزيل: الرول المطلوب (**${requestedRole.name}**) ليس أدنى من رتبة العضو الحالية (**${targetRole.name}**).`
        };
    }

    if (!isDemotion && requestedRole.position <= targetRole.position) {
        return {
            valid: false,
            error: `لا يمكن الترقية: في نفس النوع (${typeLabel}) العضو لديه رول أعلى/مساوٍ للرول المطلوب (الرول المطلوب: **${requestedRole.name}** | أعلى رول بنفس النوع: **${targetRole.name}**).`
        };
    }

    return { valid: true };
}

module.exports = { validateRoleDirection };
