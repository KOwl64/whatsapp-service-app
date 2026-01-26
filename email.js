// Email Module - placeholder implementation
module.exports = {
    init: () => {
        console.log('Email module initialized (stub)');
    },

    send: async (opts) => {
        console.log('Email send (stub):', opts.subject);
        return { success: true, messageId: 'stub-' + Date.now() };
    },

    getStatus: () => {
        return {
            configured: false,
            provider: 'stub',
            lastTest: null
        };
    },

    generateSubject: (opts) => {
        const { jobRef, vehicleReg } = opts || {};
        if (jobRef) return `POD for Job ${jobRef}`;
        if (vehicleReg) return `POD for Vehicle ${vehicleReg}`;
        return 'Proof of Delivery';
    }
};
