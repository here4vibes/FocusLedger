'use strict';
/**
 * lib/prisma.js — Singleton Prisma client.
 * WHY singleton: prevents exhausting the connection pool when server
 * hot-reloads in development (multiple PrismaClient instances each open a pool).
 */
const { PrismaClient } = require('@prisma/client');

const globalForPrisma = globalThis;
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

module.exports = { prisma };
