'use strict';

const { prisma } = require('./prisma');
const { containsText } = require('./textSearch');

async function getVisibleLibraryItems(organizationId, role, filters) {
  filters = filters || {};
  const items = await prisma.libraryItem.findMany({
    where: {
      organizationId,
      archivedAt: null,
      categoryId: filters.categoryId || undefined,
      title: typeof filters.q === 'string' && filters.q.trim() ? containsText(filters.q) : undefined,
    },
    include: { category: true },
    orderBy: { createdAt: 'desc' },
  });

  return items.filter((item) => {
    if (role === 'ADMIN' || !item.visibleRolesJson) return true;
    const roles = JSON.parse(item.visibleRolesJson);
    return roles.includes(role);
  });
}

function parseTags(tagsJson) {
  try {
    return JSON.parse(tagsJson);
  } catch {
    return [];
  }
}

module.exports = { getVisibleLibraryItems, parseTags };
